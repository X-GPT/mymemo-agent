import { type AGUIEvent, EventType } from "@ag-ui/core";
import type { TerminalRunStatus } from "@mymemo/agent-db/run-store";
import {
	encodeAgUiLiveStreamEvent,
	type LiveStreamStore,
	LiveStreamStoreError,
} from "@mymemo/live-text";
import type { WorkerLogger } from "./logger";

/** One claimed Run's best-effort AG-UI producer. Redis failure disables every
 * later write but never escapes into model execution or the Postgres Outcome. */
export class RunLiveStream {
	#enabled = false;

	private constructor(
		private readonly store: LiveStreamStore | undefined,
		private readonly runId: string,
		private readonly conversationId: string,
		private readonly logger: WorkerLogger,
	) {}

	static async open(options: {
		store: LiveStreamStore | undefined;
		runId: string;
		conversationId: string;
		logger: WorkerLogger;
	}): Promise<RunLiveStream> {
		const stream = new RunLiveStream(
			options.store,
			options.runId,
			options.conversationId,
			options.logger,
		);
		if (!options.store) return stream;
		try {
			if ((await options.store.acquire(options.runId)) !== "producer") {
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

	async append(event: AGUIEvent): Promise<void> {
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
			if (!(await this.store.refresh(this.runId))) this.#enabled = false;
		} catch (error) {
			await this.#disable(error);
		}
	}

	/** Publish only after the matching Postgres terminal transaction commits. */
	async finish(status: TerminalRunStatus): Promise<void> {
		if (!this.#enabled || !this.store) return;
		if (status === "canceled") {
			// The pinned AG-UI core has no RUN_CANCELLED event. Do not misrepresent
			// cancellation as success; recovery ticket #339 owns this terminal path.
			await this.#disable(new Error("canceled Run has no live terminal event"));
			return;
		}
		await this.append(
			status === "done"
				? {
						type: EventType.RUN_FINISHED,
						threadId: this.conversationId,
						runId: this.runId,
					}
				: { type: EventType.RUN_ERROR, message: "Run failed" },
		);
		if (!this.#enabled) return;
		try {
			await this.store.finalize(this.runId, "done");
			this.#enabled = false;
		} catch (error) {
			await this.#disable(error);
		}
	}

	async #disable(error: unknown): Promise<void> {
		const wasEnabled = this.#enabled;
		this.#enabled = false;
		this.logger.warn({
			message: "Live Stream publication disabled",
			runId: this.runId,
			reason:
				error instanceof LiveStreamStoreError ? error.code : "operation_failed",
		});
		if (!wasEnabled || !this.store) return;
		await this.store
			.finalize(this.runId, "error", "Live stream unavailable")
			.catch(() => {});
	}
}
