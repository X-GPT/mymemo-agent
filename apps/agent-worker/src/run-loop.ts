import type { Database } from "@mymemo/agent-db/client";
import { RunEventType } from "@mymemo/agent-db/run-events";
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
import type { WorkerLogger } from "./logger";
import type { Worker } from "./worker";

/**
 * What a claimed run's processing is handed. `appendText` is the bound
 * model-content append for this owned run (fenced by the run store); `signal`
 * fires when the loop observes cancellation or loses ownership, so long-running
 * processing can stop promptly.
 */
export interface RunProcessContext {
	run: RunRecord;
	signal: AbortSignal;
	appendText(text: string): Promise<void>;
}

/**
 * Produces one claimed run's turn. Milestone 3 uses a synthetic processor that
 * appends a single text event; later milestones swap in the Claude Agent SDK
 * loop. Injected so the control loop's claim/heartbeat/terminalize behavior is
 * tested independently of what a turn does.
 */
export type RunProcessor = (ctx: RunProcessContext) => Promise<void>;

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
		let failure: { error: unknown } | undefined;
		try {
			await this.opts.processor({
				run,
				signal: entry.controller.signal,
				appendText: (text) => this.appendText(run.runId, text),
			});
		} catch (error) {
			failure = { error };
		}
		// Stop heartbeating this run before terminalizing: from here the loop owns
		// the terminal transition and a concurrent heartbeat must not race it.
		this.activeRuns.delete(run.runId);
		await this.finish(run.runId, entry.state, failure);
	}

	private async appendText(runId: string, text: string): Promise<void> {
		await appendRunEventTx(this.opts.db, {
			runId,
			workerId: this.workerId,
			// The shared vocabulary type the projector maps to the `text_delta`
			// client frame — never the frame name itself, or the projector drops it.
			type: RunEventType.AssistantText,
			payload: { text },
			appendClass: "model",
		});
	}

	private async finish(
		runId: string,
		state: RunEndState,
		failure?: { error: unknown },
	): Promise<void> {
		if (state.lostOwnership) {
			this.opts.logger.warn({
				message: "abandoning run after ownership loss",
				workerId: this.workerId,
				runId,
			});
			return;
		}
		// Cancellation wins over both success and failure: an SDK error raised while
		// interrupting still surfaces to the user as `canceled`, never `error`.
		const status: TerminalRunStatus = state.canceled
			? "canceled"
			: failure
				? "error"
				: "done";
		const payload =
			status === "error" && failure
				? { message: toMessage(failure.error) }
				: undefined;
		try {
			await transitionRunTerminalTx(this.opts.db, {
				runId,
				workerId: this.workerId,
				status,
				payload,
			});
		} catch (error) {
			if (error instanceof RunFenceError) {
				// A late cancellation (or ownership expiry) raced the terminal write.
				// `done`/`error` are illegal once the run is `cancel_requested`, so try
				// `canceled` once; if even that is fenced, stale-run recovery finishes it.
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
