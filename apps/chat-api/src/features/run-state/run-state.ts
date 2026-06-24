/**
 * Run lifecycle module. A "run" is one backend execution attempt for a chat turn
 * (`runId`), recorded as an ordered NDJSON event stream so it is auditable and
 * replayable. Events persist through a {@link RunEventSink} (in prod the durable
 * `WorkspaceStore.appendRunEvent`, one object per line under
 * `users/{userId}/runs/{runId}/events.jsonl`). This module owns the event
 * vocabulary and the state machine, not persistence.
 *
 * A run starts `running` and moves once to exactly one terminal state. Recording
 * any event after a terminal transition throws, so a run can never report two
 * outcomes or log activity after it ended.
 */

import type { RunEvent, RunRef } from "@/features/workspace-store";

/**
 * Persistence primitive this module writes through — a subset of
 * {@link WorkspaceStore}, so the run module depends only on what it uses.
 */
export interface RunEventSink {
	appendRunEvent(ref: RunRef, event: RunEvent): Promise<void>;
}

/** Lifecycle state of a run. */
export type RunStatus = "running" | "completed" | "failed" | "canceled";

/** Result of an idempotent {@link Run.cancel} request. */
export interface CancelOutcome {
	/**
	 * True only when this call moved `running` → `canceled` (recording the event).
	 * False for every no-op: a repeated cancel, or one that lost the race to
	 * natural completion/failure.
	 */
	transitioned: boolean;
	/** The run's status after the call. */
	status: RunStatus;
}

/** Canonical run-event type names recorded by this module. */
export const RunEventType = {
	Started: "run_started",
	SandboxLeased: "sandbox_leased",
	DaemonStarted: "daemon_started",
	AgentEvent: "agent_event",
	Completed: "run_completed",
	Failed: "run_failed",
	Canceled: "run_canceled",
} as const;

/**
 * Event types `appendRunEvent` refuses: the start is emitted once by `createRun`
 * and outcomes by the `markRun*` markers (which also advance the state machine),
 * so neither can be recorded out of band — replay/audit see exactly one start
 * and one terminal record per run.
 */
const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
	RunEventType.Started,
	RunEventType.Completed,
	RunEventType.Failed,
	RunEventType.Canceled,
]);

/** Reserved field a daemon agent-event payload's own `type` is preserved under. */
export const AGENT_EVENT_TYPE_FIELD = "agentEventType";

export interface CreateRunOptions {
	sink: RunEventSink;
	/** Identifies the run's durable event log, scoped to its owner. */
	ref: RunRef;
	/** Product-visible thread this run belongs to. Recorded on the start event. */
	conversationId: string;
	/**
	 * Clock for event timestamps. Injectable so tests are deterministic; defaults
	 * to wall-clock ISO-8601.
	 */
	now?: () => string;
}

/**
 * Reduce any thrown value to a single human-readable message, so a failed run's
 * recorded error is a stable string regardless of what was thrown.
 */
export function normalizeRunError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	// JSON.stringify returns `undefined` (not a string) for undefined, symbols,
	// and functions, and throws on BigInt/circular values. Fall back to String()
	// in both cases so a failed run always records a non-empty error string.
	let json: string | undefined;
	try {
		json = JSON.stringify(error);
	} catch {
		json = undefined;
	}
	return json ?? String(error);
}

/**
 * A single run's lifecycle handle. Construct with {@link createRun}, which emits
 * the `run_started` event. Append intermediate events as the run progresses,
 * then call exactly one terminal marker.
 */
export class Run {
	private _status: RunStatus = "running";

	/**
	 * Serializes every operation so the status guard and the durable write form
	 * one critical section: lifecycle calls run one-at-a-time in enqueue order (so
	 * a cancel racing a streamed agent event can't interleave), the guard always
	 * sees the previous op's settled status, and the audit log never records
	 * activity after the terminal event. The tail stays fulfilled so a rejected
	 * operation doesn't stall the chain.
	 */
	private queue: Promise<void> = Promise.resolve();

	private constructor(
		private readonly sink: RunEventSink,
		private readonly ref: RunRef,
		private readonly now: () => string,
	) {}

	/** Current lifecycle state. */
	get status(): RunStatus {
		return this._status;
	}

	static async create(options: CreateRunOptions): Promise<Run> {
		const { sink, ref, conversationId } = options;
		const now = options.now ?? (() => new Date().toISOString());
		const run = new Run(sink, ref, now);
		await run.critical(() =>
			run.write({
				type: RunEventType.Started,
				conversationId,
				userId: ref.userId,
				runId: ref.runId,
			}),
		);
		return run;
	}

	/**
	 * Append one intermediate event to the durable log — the primitive behind the
	 * `record*` helpers. Stamps `at` on every event. Rejects if the run is already
	 * terminal, or if `type` is a {@link LIFECYCLE_EVENT_TYPES lifecycle-owned} type.
	 */
	appendRunEvent(event: RunEvent): Promise<void> {
		if (LIFECYCLE_EVENT_TYPES.has(event.type)) {
			return Promise.reject(
				new Error(
					`Cannot append lifecycle-owned event "${event.type}" via appendRunEvent; it is recorded by createRun/markRun* (run ${this.ref.runId})`,
				),
			);
		}
		return this.critical(() => {
			this.ensureRunning(event.type);
			return this.write(event);
		});
	}

	/** Record that a sandbox was leased for this run. */
	recordSandboxLeased(sandboxId: string): Promise<void> {
		return this.appendRunEvent({ type: RunEventType.SandboxLeased, sandboxId });
	}

	/** Record that the in-sandbox daemon was started. */
	recordDaemonStarted(): Promise<void> {
		return this.appendRunEvent({ type: RunEventType.DaemonStarted });
	}

	/**
	 * Record an agent event. The `agent_event` label is applied after the payload
	 * so a daemon field named `type` can't mislabel it; the daemon's own
	 * discriminator (e.g. `text_delta`) is preserved under `agentEventType` so the
	 * run log can replay the original stream.
	 */
	recordAgentEvent(data: Record<string, unknown>): Promise<void> {
		const { type: daemonType, ...rest } = data;
		return this.appendRunEvent({
			...rest,
			...(daemonType !== undefined
				? { [AGENT_EVENT_TYPE_FIELD]: daemonType }
				: {}),
			type: RunEventType.AgentEvent,
		});
	}

	/** Mark the run completed successfully. */
	markRunCompleted(): Promise<void> {
		return this.terminate("completed", { type: RunEventType.Completed });
	}

	/**
	 * Mark the run failed. The thrown value is normalized to a single message so
	 * the failure event always carries a stable, readable `error`.
	 */
	markRunFailed(error: unknown): Promise<void> {
		return this.terminate("failed", {
			type: RunEventType.Failed,
			error: normalizeRunError(error),
		});
	}

	/** Mark the run canceled. */
	markRunCanceled(): Promise<void> {
		return this.terminate("canceled", { type: RunEventType.Canceled });
	}

	/**
	 * Idempotent, best-effort cancellation — safe to call repeatedly or after the
	 * run has ended (unlike the strict `markRun*` terminals):
	 *
	 *  - `running` → records `run_canceled`, advances, `transitioned: true`.
	 *  - already `canceled` → no-op, no duplicate event, `transitioned: false`.
	 *  - `completed` / `failed` → no-op; cancellation lost the race,
	 *    `transitioned: false`.
	 *
	 * Tolerating the terminal states keeps the single-start/single-terminal audit
	 * invariant intact; `transitioned` lets callers fire the daemon cancellation
	 * hook only when this call actually performed the cancellation.
	 */
	cancel(): Promise<CancelOutcome> {
		return this.critical(async () => {
			if (this._status !== "running") {
				return { transitioned: false, status: this._status };
			}
			// Persist before advancing, same ordering rule as terminate(): a failed
			// write leaves the run running so the cancel can be retried.
			await this.write({ type: RunEventType.Canceled });
			this._status = "canceled";
			return { transitioned: true, status: "canceled" };
		});
	}

	private terminate(
		status: Exclude<RunStatus, "running">,
		event: RunEvent,
	): Promise<void> {
		return this.critical(async () => {
			if (this._status !== "running") {
				throw new Error(
					`Run ${this.ref.runId} already ${this._status}; cannot mark ${status}`,
				);
			}
			// Persist before advancing status: if the sink rejects, the run stays
			// `running` so the outcome can be retried rather than being stuck terminal
			// with no record of how it ended. This guarantee is only as strong as the
			// sink; one that resolves on a failed terminal write (the chat SSE sink
			// does, to decouple signaling from audit durability) advances anyway.
			await this.write(event);
			this._status = status;
		});
	}

	private ensureRunning(eventType: string): void {
		if (this._status !== "running") {
			throw new Error(
				`Cannot append "${eventType}" to a ${this._status} run (${this.ref.runId})`,
			);
		}
	}

	private write(event: RunEvent): Promise<void> {
		// `at` is the authoritative server stamp, applied after the payload so a
		// passthrough field named `at` cannot override it (same rule as `type`).
		return this.sink.appendRunEvent(this.ref, { ...event, at: this.now() });
	}

	/**
	 * Run `fn` as a critical section serialized after all prior operations. The
	 * caller observes `fn`'s own outcome; the internal tail swallows rejections so
	 * one failed operation does not block the next.
	 */
	private critical<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn);
		this.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

/**
 * Begin a run: emit `run_started` and return its lifecycle handle.
 */
export function createRun(options: CreateRunOptions): Promise<Run> {
	return Run.create(options);
}
