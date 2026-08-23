import { EventType } from "@ag-ui/core";
import type { TerminalRunStatus } from "@mymemo/agent-db/run-store";
import {
	classifyLiveStreamFailure,
	disabledLiveStreamTelemetry,
	encodeAgUiLiveStreamEvent,
	type LiveStreamEvent,
	type LiveStreamProducer,
	type LiveStreamReason,
	type LiveStreamRelay,
	type LiveStreamTelemetry,
	RUN_INTERRUPTED_EVENT_TYPE,
} from "@mymemo/live-text";
import type { RuntimeLogger } from "./logger";

export interface LiveStreamFailureMarker {
	outcome: "marked" | "already_failed";
	failedAt: Date;
}

/** One executing Run's best-effort AG-UI producer. Relay failure disables every
 * later write but never escapes into model execution or the Postgres Outcome. */
export class RunLiveStream {
	#enabled = false;
	#failed = false;
	#failureMarked = false;
	#failureReason: LiveStreamReason = "redis_unavailable";
	#failedAt: Date | undefined;
	#degradationEnded = false;
	#producer: LiveStreamProducer | undefined;

	private constructor(
		private readonly runId: string,
		private readonly conversationId: string,
		private readonly markLiveStreamFailed: () => Promise<LiveStreamFailureMarker>,
		private readonly logger: RuntimeLogger,
		private readonly telemetry: LiveStreamTelemetry,
	) {}

	static async open(options: {
		relay: LiveStreamRelay;
		runId: string;
		conversationId: string;
		markLiveStreamFailed: () => Promise<LiveStreamFailureMarker>;
		logger: RuntimeLogger;
		telemetry?: LiveStreamTelemetry;
	}): Promise<RunLiveStream> {
		const stream = new RunLiveStream(
			options.runId,
			options.conversationId,
			options.markLiveStreamFailed,
			options.logger,
			options.telemetry ?? disabledLiveStreamTelemetry,
		);
		try {
			stream.#producer = await options.relay.openProducer(options.runId);
			stream.#enabled = true;
			await stream.append({
				type: EventType.RUN_STARTED,
				threadId: options.conversationId,
				runId: options.runId,
			});
		} catch (error) {
			await stream.#disable(error);
		}
		return stream;
	}

	async append(event: LiveStreamEvent): Promise<void> {
		if (!this.#enabled) return;
		try {
			for (const chunk of encodeAgUiLiveStreamEvent(event)) {
				await this.#producer?.append(chunk);
			}
		} catch (error) {
			await this.#disable(error);
		}
	}

	/** Publish only after the matching Postgres terminal transaction commits. */
	async finish(status: TerminalRunStatus): Promise<void> {
		if (!this.#enabled) {
			await this.#retryFailureMarker();
			await this.#closeProducer();
			this.#recordDegradationEnded();
			return;
		}
		try {
			const event: LiveStreamEvent =
				status === "interrupted"
					? {
							type: RUN_INTERRUPTED_EVENT_TYPE,
							threadId: this.conversationId,
							runId: this.runId,
						}
					: status === "done"
						? {
								type: EventType.RUN_FINISHED,
								threadId: this.conversationId,
								runId: this.runId,
							}
						: { type: EventType.RUN_ERROR, message: "Run failed" };
			const [chunk] = encodeAgUiLiveStreamEvent(event);
			if (!chunk) throw new Error("Terminal Live Stream event encoded empty");
			await this.#producer?.publishTerminal(chunk);
			this.#enabled = false;
		} catch (error) {
			await this.#disable(error);
			await this.#retryFailureMarker();
		} finally {
			await this.#closeProducer();
		}
		this.#recordDegradationEnded();
	}

	/** Release a producer when this Runtime can no longer terminalize the Run. */
	async close(): Promise<void> {
		this.#enabled = false;
		await this.#closeProducer();
		this.#recordDegradationEnded();
	}

	async #disable(error: unknown): Promise<void> {
		this.#enabled = false;
		this.#failed = true;
		this.#failureReason = classifyLiveStreamFailure(error);
		this.logger.warn({
			message: "Live Stream publication disabled",
			runId: this.runId,
			reason: this.#failureReason,
		});
		await this.#persistFailureMarker();
	}

	async #persistFailureMarker(): Promise<void> {
		try {
			const marker = await this.markLiveStreamFailed();
			this.#failureMarked = true;
			this.#failedAt = marker.failedAt;
			if (marker.outcome === "marked") {
				this.telemetry.record("degradation", "started", {
					reason: this.#failureReason,
				});
			}
		} catch {
			this.logger.error({
				message: "could not mark Live Stream failed",
				runId: this.runId,
				reason: "marker_write_failed",
			});
			this.telemetry.record("degradation", "failure", {
				reason: "marker_write_failed",
			});
		}
	}

	async #retryFailureMarker(): Promise<void> {
		if (this.#failed && !this.#failureMarked) {
			await this.#persistFailureMarker();
		}
	}

	#recordDegradationEnded(): void {
		if (this.#degradationEnded || !this.#failedAt) return;
		this.#degradationEnded = true;
		this.telemetry.record("degradation", "ended", {
			reason: this.#failureReason,
			durationMs: Date.now() - this.#failedAt.getTime(),
		});
	}

	async #closeProducer(): Promise<void> {
		const producer = this.#producer;
		this.#producer = undefined;
		await producer?.close().catch(() => {});
	}
}
