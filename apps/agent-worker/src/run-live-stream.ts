import { EventType } from "@ag-ui/core";
import type { TerminalRunStatus } from "@mymemo/agent-db/run-store";
import {
	encodeAgUiLiveStreamEvent,
	type LiveStreamEvent,
	type LiveStreamStore,
	LiveStreamStoreError,
	RUN_CANCELLED_EVENT_TYPE,
} from "@mymemo/live-text";
import { toMessage, type WorkerLogger } from "./logger";

/** One claimed Run's best-effort AG-UI producer. Redis failure disables every
 * later write but never escapes into model execution or the Postgres Outcome. */
export class RunLiveStream {
	#enabled = false;
	#failed = false;
	#failureMarked = false;

	private constructor(
		private readonly store: LiveStreamStore | undefined,
		private readonly runId: string,
		private readonly conversationId: string,
		private readonly markLiveStreamFailed: () => Promise<void>,
		private readonly logger: WorkerLogger,
	) {}

	static async open(options: {
		store: LiveStreamStore | undefined;
		runId: string;
		conversationId: string;
		markLiveStreamFailed: () => Promise<void>;
		logger: WorkerLogger;
	}): Promise<RunLiveStream> {
		const stream = new RunLiveStream(
			options.store,
			options.runId,
			options.conversationId,
			options.markLiveStreamFailed,
			options.logger,
		);
		if (!options.store) return stream;
		try {
			if ((await options.store.acquire(options.runId)) !== "producer") {
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
		if (!this.#enabled || !this.store) return;
		try {
			for (const chunk of encodeAgUiLiveStreamEvent(event)) {
				await this.store.append(this.runId, chunk);
			}
		} catch (error) {
			await this.#disable(error);
		}
	}

	async refresh(): Promise<void> {
		if (!this.#enabled || !this.store) return;
		try {
			if (!(await this.store.refresh(this.runId))) {
				await this.#disable(new LiveStreamStoreError("finalized"));
			}
		} catch (error) {
			await this.#disable(error);
		}
	}

	/** Publish only after the matching Postgres terminal transaction commits. */
	async finish(status: TerminalRunStatus): Promise<void> {
		if (!this.#enabled || !this.store) {
			await this.#retryFailureMarker();
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
			return;
		}
		try {
			await this.store.finalize(this.runId, "done");
			this.#enabled = false;
		} catch (error) {
			await this.#disable(error);
			await this.#retryFailureMarker();
		}
	}

	async #disable(error: unknown): Promise<void> {
		const wasEnabled = this.#enabled;
		this.#enabled = false;
		this.#failed = true;
		this.logger.warn({
			message: "Live Stream publication disabled",
			runId: this.runId,
			reason:
				error instanceof LiveStreamStoreError ? error.code : "operation_failed",
		});
		await this.#persistFailureMarker();
		if (!wasEnabled || !this.store) return;
		await this.store
			.finalize(this.runId, "error", "Live stream unavailable")
			.catch(() => {});
	}

	async #persistFailureMarker(): Promise<void> {
		try {
			await this.markLiveStreamFailed();
			this.#failureMarked = true;
		} catch (markerError) {
			this.logger.error({
				message: "could not mark Live Stream failed",
				runId: this.runId,
				error: toMessage(markerError),
			});
		}
	}

	async #retryFailureMarker(): Promise<void> {
		if (this.#failed && !this.#failureMarked) {
			await this.#persistFailureMarker();
		}
	}
}
