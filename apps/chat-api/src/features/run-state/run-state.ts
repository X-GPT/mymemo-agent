/**
 * Run lifecycle module. A "run" is one backend execution attempt for a chat turn
 * (identified by `runId`). This module records the run's lifecycle as an ordered
 * stream of events so a run is auditable and replayable after the fact.
 *
 * Events are persisted as NDJSON through a {@link RunEventSink} — in production
 * the durable `WorkspaceStore.appendRunEvent`, which writes one JSON object per
 * line to `users/{userId}/runs/{runId}/events.jsonl`. This module owns the event
 * vocabulary and the lifecycle state machine; it does not own persistence.
 *
 * A run starts in `running` and moves once to exactly one terminal state
 * (`completed`, `failed`, or `canceled`). Recording any event after a terminal
 * transition is a programming error and throws, so a run can never report two
 * outcomes or log activity after it has ended. Wiring this module into the chat
 * orchestration path (and mapping run events onto client SSE) is a later task.
 */

import type { RunEvent, RunRef } from "@/features/workspace-store";

/**
 * The persistence primitive this module writes through. A subset of
 * {@link WorkspaceStore} so the run module depends only on what it uses and is
 * trivial to fake in tests.
 */
export interface RunEventSink {
	appendRunEvent(ref: RunRef, event: RunEvent): Promise<void>;
}

/** Lifecycle state of a run. */
export type RunStatus = "running" | "completed" | "failed" | "canceled";

/** Canonical run-event type names recorded by this module. */
export const RunEventType = {
	Started: "run_started",
	SandboxLeased: "sandbox_leased",
	DaemonStarted: "daemon_started",
	AgentEvent: "agent_event",
	Hydration: "hydration",
	Completed: "run_completed",
	Failed: "run_failed",
	Canceled: "run_canceled",
} as const;

/**
 * Lifecycle-owned event types. The start record is emitted once by `createRun`,
 * and the terminal records are emitted by the markers
 * (`markRunCompleted`/`markRunFailed`/`markRunCanceled`), which also advance the
 * state machine. The generic `appendRunEvent` primitive rejects all of them so a
 * caller cannot record a second start or an outcome out of band — replay/audit
 * consumers see exactly one start and one terminal record per run.
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
	 * one critical section. Two lifecycle calls that are not awaited in sequence
	 * (e.g. cancellation racing a streamed agent event once cancellation is wired)
	 * therefore still run one-at-a-time and in enqueue order — the audit log never
	 * records activity after the terminal event, and the guard always sees the
	 * settled status of the previous operation. The tail is kept always-fulfilled
	 * so a rejected operation does not stall the chain.
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
	 * Append one intermediate event to the run's durable log. The primitive behind
	 * the `record*` helpers; callers pass a non-lifecycle `type` plus any structured
	 * fields, and a timestamp (`at`) is stamped on every event. Rejects if the run
	 * has already reached a terminal state, or if `type` is a lifecycle-owned type
	 * (`run_started` and the terminal types) — the start is emitted by `createRun`
	 * and outcomes by the `markRun*` markers, so neither may be recorded out of band.
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
	 * Record an agent event. The `agent_event` category label is authoritative —
	 * applied after the payload so a daemon field named `type` cannot mislabel the
	 * event — but the daemon's own discriminator (e.g. `text_delta`, `session_id`)
	 * is preserved under `agentEventType` so the run log can replay the original
	 * stream rather than guessing from optional fields.
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

	/** Record a document hydration event. The category label is authoritative. */
	recordHydration(data: Record<string, unknown>): Promise<void> {
		return this.appendRunEvent({ ...data, type: RunEventType.Hydration });
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
			// Persist the terminal event before advancing the status. If the write
			// rejects (e.g. ENOSPC, transient store failure) the run stays `running`
			// so the outcome can be retried, rather than being stuck terminal with no
			// durable record of how it ended.
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
	private critical(fn: () => Promise<void>): Promise<void> {
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
