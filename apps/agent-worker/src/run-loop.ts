import type { Database } from "@mymemo/agent-db/client";
import {
	type AssistantTextPayload,
	RunEventType,
} from "@mymemo/agent-db/run-events";
import {
	appendRunEventTx,
	claimNextRunTx,
	heartbeatRunTx,
	markStaleRunsTx,
	RunFenceError,
	type RunRecord,
	type TerminalRunStatus,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";
import { advanceAgentSessionPointerTx } from "@mymemo/agent-db/runtime-store";
import type { WorkerLogger } from "./logger";
import type { Worker } from "./worker";

/**
 * What a processor reports back about the turn it just ran. Workspace files
 * need no end-of-turn handling (ADR-0007): the sandbox idle-pauses once the
 * turn stops renewing it, and the paused sandbox *is* the persisted workspace.
 */
export interface TurnResult {
	/**
	 * The agent session to record as the conversation's resume pointer once the
	 * turn terminalizes `done` (ADR-0005). Present only when the SDK produced a
	 * session id AND no `mirror_error` made the mirrored transcript unreliable —
	 * a dropped-mirror turn omits it, so the pointer does not advance yet the run
	 * still succeeds. Absent for synthetic turns that ran no query.
	 */
	agentSession?: { sessionId: string } | null;
}

/** A processor that reports nothing is normalized to a turn with no session
 * pointer to advance (the Milestone 3 synthetic turn). */
const EMPTY_TURN: TurnResult = {};

/**
 * What a claimed run's processing is handed. `appendAssistantMessage` is the
 * bound durable-message append for this owned run (fenced by the run store);
 * `signal` fires when the loop observes cancellation or loses ownership, so
 * long-running processing can stop promptly.
 */
export interface RunProcessContext {
	run: RunRecord;
	signal: AbortSignal;
	appendAssistantMessage(message: AssistantTextPayload): Promise<void>;
}

/**
 * Produces one claimed run's turn. Injected so the control loop's
 * claim/heartbeat/terminalize behavior is tested independently of what a turn
 * does.
 *
 * A processor may return a {@link TurnResult} naming the agent session to
 * resume from next turn; returning nothing is treated as a turn with no
 * session to record, so the Milestone 3 synthetic processor needs no change.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` keeps a nothing-returning processor valid — `undefined` is not assignable from a void-returning async fn.
type RunTurnResult = void | TurnResult;

export type RunProcessor = (ctx: RunProcessContext) => Promise<RunTurnResult>;

export interface RunLoopOptions {
	db: Database;
	worker: Worker;
	processor: RunProcessor;
	/** How often {@link RunLoop.start}'s timer fires a tick (heartbeat + claim). */
	heartbeatIntervalMs: number;
	logger: WorkerLogger;
}

/** Per-run loop-local state, resolved once processing ends into a terminal. */
interface RunEndState {
	/** A heartbeat observed `cancel_requested`; the terminal must be `canceled`. */
	canceled: boolean;
	/** A heartbeat lost the ownership fence; recovery owns the run — do not
	 * terminalize it. */
	lostOwnership: boolean;
}

interface ActiveEntry {
	controller: AbortController;
	state: RunEndState;
}

const STALE_RUN_RECOVERY_INTERVAL_MS = 15_000;
const GENERIC_RUN_ERROR_MESSAGE = "Run failed";

/**
 * The agent-worker control loop over the shared run-store helpers. One `tick`:
 *  1. terminalizes stale runs through the shared recovery helper;
 *  2. heartbeats every run this worker is executing — renewing `locked_until`
 *     and, in the same call, observing a `cancel_requested` or a lost ownership
 *     fence; and
 *  3. claims queued runs up to the supervisor's remaining capacity and
 *     dispatches each onto it.
 *
 * `tick` is the whole loop and is directly awaitable, so tests drive recovery,
 * claim, heartbeat, and terminalization deterministically (PGlite + explicit
 * ticks, no wall-clock timers — Bun lacks `setInterval` fake timers). `start`
 * schedules both `tick` and the at-least-15s recovery sweep; `stop`
 * unschedules them and drains in-flight runs.
 *
 * Ownership and single-terminalization are enforced by the DB fences in the
 * helpers, not here: two workers cannot claim one run (`FOR UPDATE SKIP
 * LOCKED`), stale workers are fenced by `locked_by` + `locked_until`, and
 * recovery CASes the same active statuses as worker terminalization. This
 * loop's job is to turn those helpers into a warm, bounded-concurrency service.
 */
export class RunLoop {
	private readonly activeRuns = new Map<string, ActiveEntry>();
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly opts: RunLoopOptions) {}

	private get workerId(): string {
		return this.opts.worker.workerId;
	}

	/**
	 * Run one control-loop iteration: recover stale runs, heartbeat active runs,
	 * then claim and dispatch queued runs up to capacity. Returns how many runs
	 * were claimed this tick.
	 */
	async tick(): Promise<number> {
		await this.tryRecoverStaleRuns();
		await this.heartbeatActive();
		return this.claimAndDispatch();
	}

	/** Begin ticking on a timer. The first tick runs immediately so queued work
	 * is picked up without waiting a full interval. */
	start(): void {
		if (this.running) return;
		this.running = true;
		const runTick = async (): Promise<void> => {
			if (!this.running) return;
			try {
				await this.tick();
			} catch (error) {
				this.opts.logger.error({
					message: "run loop tick failed",
					workerId: this.workerId,
					error: toMessage(error),
				});
			} finally {
				if (this.running) {
					this.timer = setTimeout(runTick, this.opts.heartbeatIntervalMs);
				}
			}
		};
		void runTick();
		this.recoveryTimer = setTimeout(
			() => void this.runRecoveryTimer(),
			STALE_RUN_RECOVERY_INTERVAL_MS,
		);
	}

	/** Stop scheduling new ticks and drain in-flight runs via the supervisor. */
	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}
		// Interrupt every in-flight run before draining: aborting the run's
		// controller is what makes its processor interrupt the live SDK query and
		// cancel any active E2B command (plan Task 7.2). This is not a user cancel,
		// so `state.canceled` stays false — an interrupted turn drains to `error`,
		// never a false `done`. Snapshot the map: a finishing run deletes itself.
		for (const entry of [...this.activeRuns.values()]) {
			entry.controller.abort();
		}
		await this.opts.worker.shutdown();
	}

	private async runRecoveryTimer(): Promise<void> {
		if (!this.running) return;
		try {
			await this.tryRecoverStaleRuns();
		} finally {
			if (this.running) {
				this.recoveryTimer = setTimeout(
					() => void this.runRecoveryTimer(),
					STALE_RUN_RECOVERY_INTERVAL_MS,
				);
			}
		}
	}

	private async tryRecoverStaleRuns(): Promise<void> {
		try {
			await this.recoverStaleRuns();
		} catch (error) {
			this.opts.logger.error({
				message: "stale-run recovery failed",
				workerId: this.workerId,
				error: toMessage(error),
			});
		}
	}

	private async recoverStaleRuns(): Promise<void> {
		const recovered = await markStaleRunsTx(this.opts.db);
		if (recovered.length === 0) return;
		this.opts.logger.warn({
			message: "recovered stale runs",
			workerId: this.workerId,
			recoveredRuns: recovered.map((run) => ({
				runId: run.runId,
				status: run.status,
			})),
		});
	}

	private async heartbeatActive(): Promise<void> {
		// Snapshot: a run finishing mid-iteration removes itself from the map.
		for (const [runId, entry] of [...this.activeRuns]) {
			let renewed: RunRecord | null;
			try {
				renewed = await heartbeatRunTx(this.opts.db, {
					runId,
					workerId: this.workerId,
				});
			} catch (error) {
				// Transient DB error: the next tick retries well before the 60s lock
				// deadline actually lapses, so drop this beat rather than abandon.
				this.opts.logger.error({
					message: "heartbeat failed",
					workerId: this.workerId,
					runId,
					error: toMessage(error),
				});
				continue;
			}
			if (!renewed) {
				// Ownership lost — expired, or recovery/another worker took it. The run
				// is no longer ours to terminalize; abandon it. Drop it from
				// activeRuns now so later ticks stop heartbeating a run we no longer
				// own (runClaimed's own delete then becomes a no-op); `finish()` still
				// sees `lostOwnership` through the retained `entry` and skips the
				// terminal transition.
				this.activeRuns.delete(runId);
				entry.state.lostOwnership = true;
				entry.controller.abort();
				continue;
			}
			if (renewed.status === "cancel_requested") {
				entry.state.canceled = true;
				entry.controller.abort();
			}
		}
	}

	private async claimAndDispatch(): Promise<number> {
		let started = 0;
		while (this.opts.worker.hasCapacity) {
			const run = await claimNextRunTx(this.opts.db, {
				workerId: this.workerId,
			});
			if (!run) break;
			const entry: ActiveEntry = {
				controller: new AbortController(),
				state: { canceled: false, lostOwnership: false },
			};
			this.activeRuns.set(run.runId, entry);
			const dispatched = this.opts.worker.tryStart(() =>
				this.runClaimed(run, entry),
			);
			if (!dispatched) {
				// Capacity vanished between the check and dispatch (a drain began). The
				// run is claimed but unrun; drop local tracking and let stale-run
				// recovery terminalize it — a v1 run is never re-dispatched.
				this.activeRuns.delete(run.runId);
				this.opts.logger.warn({
					message: "claimed run not dispatched; leaving to recovery",
					workerId: this.workerId,
					runId: run.runId,
				});
				break;
			}
			started++;
		}
		return started;
	}

	private async runClaimed(run: RunRecord, entry: ActiveEntry): Promise<void> {
		let turnResult: TurnResult = EMPTY_TURN;
		let failure: { error: unknown } | undefined;
		try {
			turnResult =
				(await this.opts.processor({
					run,
					signal: entry.controller.signal,
					appendAssistantMessage: (message) =>
						this.appendAssistantMessage(run.runId, message),
				})) ?? EMPTY_TURN;
		} catch (error) {
			failure = { error };
		}
		// Stop heartbeating this run before terminalizing: from here the loop owns
		// the terminal transition and a concurrent heartbeat must not race it.
		this.activeRuns.delete(run.runId);
		await this.finish(run, entry.state, turnResult, failure);
	}

	private async appendAssistantMessage(
		runId: string,
		message: AssistantTextPayload,
	): Promise<void> {
		await appendRunEventTx(this.opts.db, {
			runId,
			workerId: this.workerId,
			// The shared vocabulary type the projector maps to `text_commit` — never
			// the frame name itself, or the projector drops it.
			type: RunEventType.AssistantText,
			payload: message,
			appendClass: "model",
		});
	}

	private async finish(
		run: RunRecord,
		state: RunEndState,
		turnResult: TurnResult,
		failure?: { error: unknown },
	): Promise<void> {
		const runId = run.runId;
		if (state.lostOwnership) {
			this.opts.logger.warn({
				message: "abandoning run after ownership loss",
				workerId: this.workerId,
				runId,
			});
			return;
		}
		// Cancellation wins over both success and failure: an SDK error raised
		// while interrupting still surfaces as `canceled`.
		if (state.canceled) {
			await this.terminalize(runId, "canceled");
			return;
		}
		if (failure) {
			this.opts.logger.error({
				message: "run failed",
				workerId: this.workerId,
				userId: run.userId,
				conversationId: run.conversationId,
				runId,
				error: toMessage(failure.error),
			});
			await this.terminalize(runId, "error", {
				message: GENERIC_RUN_ERROR_MESSAGE,
			});
			return;
		}
		// Success: terminalize `done` directly — there is no end-of-turn
		// checkpoint (ADR-0007); the sandbox idle-pauses once renewal stops and is
		// itself the persisted workspace. The terminal-success transition also
		// advances the conversation's resume pointer, under the ownership fence
		// (ADR-0005). Only when the turn reported a session to resume from — a
		// `mirror_error` turn carries none, so the pointer holds and the run still
		// terminalizes `done`.
		if (turnResult.agentSession) {
			await this.advanceSessionPointer(run, turnResult.agentSession.sessionId);
		}
		await this.terminalize(runId, "done");
	}

	/**
	 * Advance the conversation's Claude Agent SDK resume pointer through the fenced
	 * runtime helper. Best-effort (ADR-0005): a failure — the fence lost to
	 * recovery, or a transient DB error — only leaves the next turn resuming from
	 * the previous session, losing this turn's model-side memory; the user-visible
	 * run still succeeds, so the terminal `done` must not be blocked by it.
	 */
	private async advanceSessionPointer(
		run: RunRecord,
		agentSessionId: string,
	): Promise<void> {
		try {
			await advanceAgentSessionPointerTx(this.opts.db, {
				userId: run.userId,
				conversationId: run.conversationId,
				runId: run.runId,
				workerId: this.workerId,
				agentSessionId,
			});
		} catch (error) {
			this.opts.logger.warn({
				message: "could not advance agent session pointer",
				workerId: this.workerId,
				runId: run.runId,
				error: toMessage(error),
			});
		}
	}

	/**
	 * Append the run's terminal event through the fenced run-store helper, with
	 * the late-cancellation fallback the loop relies on: `done`/`error` lose to a
	 * cancellation the terminal CAS observes (the run is already
	 * `cancel_requested`), so on a fence rejection try `canceled` once; if even
	 * that is fenced, stale-run recovery finishes the run.
	 */
	private async terminalize(
		runId: string,
		status: TerminalRunStatus,
		payload?: { message: string },
	): Promise<void> {
		try {
			await transitionRunTerminalTx(this.opts.db, {
				runId,
				workerId: this.workerId,
				status,
				payload,
			});
		} catch (error) {
			if (error instanceof RunFenceError) {
				if (status !== "canceled" && (await this.tryTerminalCanceled(runId))) {
					return;
				}
				this.opts.logger.warn({
					message: "could not terminalize run; leaving to stale-run recovery",
					workerId: this.workerId,
					runId,
					intended: status,
				});
				return;
			}
			throw error;
		}
	}

	private async tryTerminalCanceled(runId: string): Promise<boolean> {
		try {
			await transitionRunTerminalTx(this.opts.db, {
				runId,
				workerId: this.workerId,
				status: "canceled",
			});
			return true;
		} catch {
			return false;
		}
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
