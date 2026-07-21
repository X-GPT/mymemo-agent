import { EventType } from "@ag-ui/core";
import type { TerminalRunStatus } from "@mymemo/agent-db/run-store";
import {
	classifyLiveStreamFailure,
	disabledLiveStreamTelemetry,
	encodeAgUiLiveStreamEvent,
	type LiveStreamEvent,
	type LiveStreamOperation,
	type LiveStreamReason,
	type LiveStreamResult,
	type LiveStreamStore,
	LiveStreamStoreError,
	type LiveStreamTelemetry,
	RUN_CANCELLED_EVENT_TYPE,
} from "@mymemo/live-text";
import type { WorkerLogger } from "./logger";

export interface LiveStreamFailureMarker {
	outcome: "marked" | "already_failed";
	failedAt: Date;
}

/** One claimed Run's best-effort AG-UI producer. Redis failure disables every
 * later write but never escapes into model execution or the Postgres Outcome. */
export class RunLiveStream {
	#enabled = false;
	#failed = false;
	#failureMarked = false;
	#failureReason: LiveStreamReason = "redis_unavailable";
	#failedAt: Date | undefined;
	#degradationEnded = false;

	private constructor(
		private readonly store: LiveStreamStore | undefined,
		private readonly runId: string,
		private readonly conversationId: string,
		private readonly markLiveStreamFailed: () => Promise<LiveStreamFailureMarker>,
		private readonly logger: WorkerLogger,
		private readonly telemetry: LiveStreamTelemetry,
	) {}

	static async open(options: {
		store: LiveStreamStore | undefined;
		runId: string;
		conversationId: string;
		markLiveStreamFailed: () => Promise<LiveStreamFailureMarker>;
		logger: WorkerLogger;
		telemetry?: LiveStreamTelemetry;
	}): Promise<RunLiveStream> {
		const store = options.store;
		const stream = new RunLiveStream(
			store,
			options.runId,
			options.conversationId,
			options.markLiveStreamFailed,
			options.logger,
			options.telemetry ?? disabledLiveStreamTelemetry,
		);
		if (!store) {
			stream.telemetry.record("acquire", "failure", {
				reason: "not_configured",
			});
			return stream;
		}
		try {
			const role = await stream.#observe(
				"acquire",
				(value) => (value === "producer" ? "producer" : "consumer"),
				() => store.acquire(options.runId),
			);
			if (role !== "producer") {
				await stream.#disable(new LiveStreamStoreError("not_producer"));
				return stream;
			}
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
		const store = this.store;
		if (!this.#enabled || !store) return;
		try {
			await this.#observe(
				"append",
				() => "success",
				async () => {
					for (const chunk of encodeAgUiLiveStreamEvent(event)) {
						await store.append(this.runId, chunk);
					}
				},
			);
		} catch (error) {
			await this.#disable(error);
		}
	}

	async refresh(): Promise<void> {
		const store = this.store;
		if (!this.#enabled || !store) return;
		try {
			const refreshed = await this.#observe(
				"refresh",
				(value) => (value ? "success" : "finalized"),
				() => store.refresh(this.runId),
			);
			if (!refreshed) {
				await this.#disable(new LiveStreamStoreError("finalized"));
			}
		} catch (error) {
			await this.#disable(error);
		}
	}

	/** Publish only after the matching Postgres terminal transaction commits. */
	async finish(status: TerminalRunStatus): Promise<void> {
		const store = this.store;
		if (!this.#enabled || !store) {
			await this.#retryFailureMarker();
			this.#recordDegradationEnded();
			return;
		}
		if (status === "canceled") {
			await this.append({
				type: RUN_CANCELLED_EVENT_TYPE,
				threadId: this.conversationId,
				runId: this.runId,
			});
		} else {
			await this.append(
				status === "done"
					? {
							type: EventType.RUN_FINISHED,
							threadId: this.conversationId,
							runId: this.runId,
						}
					: { type: EventType.RUN_ERROR, message: "Run failed" },
			);
		}
		if (!this.#enabled) {
			await this.#retryFailureMarker();
			this.#recordDegradationEnded();
			return;
		}
		try {
			await this.#observe(
				"finalize",
				() => "success",
				() => store.finalize(this.runId, "done"),
			);
			this.#enabled = false;
		} catch (error) {
			await this.#disable(error);
			await this.#retryFailureMarker();
		}
		this.#recordDegradationEnded();
	}

	async #disable(error: unknown): Promise<void> {
		const wasEnabled = this.#enabled;
		this.#enabled = false;
		this.#failed = true;
		this.#failureReason = classifyLiveStreamFailure(error);
		this.logger.warn({
			message: "Live Stream publication disabled",
			runId: this.runId,
			reason: this.#failureReason,
		});
		await this.#persistFailureMarker();
		if (!wasEnabled || !this.store) return;
		const store = this.store;
		await this.#observe(
			"finalize",
			() => "success",
			() => store.finalize(this.runId, "error", "Live stream unavailable"),
		).catch(() => {});
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

	async #observe<T>(
		operation: LiveStreamOperation,
		result: (value: T) => LiveStreamResult,
		execute: () => Promise<T>,
	): Promise<T> {
		const startedAt = Date.now();
		try {
			const value = await execute();
			this.telemetry.record(operation, result(value), {
				durationMs: Date.now() - startedAt,
			});
			return value;
		} catch (error) {
			this.telemetry.record(operation, "failure", {
				reason: classifyLiveStreamFailure(error),
				durationMs: Date.now() - startedAt,
			});
			throw error;
		}
	}
}
