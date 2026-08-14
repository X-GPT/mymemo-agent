import type { Database } from "@mymemo/agent-db/client";
import {
	type ConversationOwner,
	claimConversationTx,
	releaseConversationTx,
} from "@mymemo/agent-db/conversation-ownership";
import {
	expireUnownedQueuedRunsTx,
	type RunRecord,
	type RunWriteRejected,
	reclaimConversationTx,
	startClaimedRunTx,
} from "@mymemo/agent-db/run-store";
import type { LiveStreamRelay, LiveStreamTelemetry } from "@mymemo/live-text";
import { toMessage, type WorkerLogger } from "./logger";
import { renewOwnershipLease } from "./ownership-lease";
import { DoorbellTicker, type RunDoorbell } from "./run-doorbell";
import {
	createRunServing,
	type RunProcessor,
	type RunServing,
} from "./run-serving";
import {
	classifyRunWriteRejection,
	type OwnershipLoss,
	type OwnershipLossReason,
} from "./run-write-rejection";
import type { Worker } from "./worker";

export interface RunLoopOptions {
	db: Database;
	worker: Worker;
	processor: RunProcessor;
	/** Required AG-UI relay. Runtime failures keep durable execution available. */
	liveStreamRelay: LiveStreamRelay;
	/** Payload-free Live Stream relay operation metrics. */
	liveStreamTelemetry?: LiveStreamTelemetry;
	/** How often {@link RunLoop.start}'s timer fires a tick (Ownership renewal + Claim). */
	heartbeatIntervalMs: number;
	/** Optional doorbell whose ring triggers an immediate tick. */
	doorbell?: RunDoorbell;
	logger: WorkerLogger;
}

interface ActiveEntry {
	runId: string;
	shutdownController: AbortController;
}

/** One Claimed Conversation being drained by this worker. */
interface ActiveDrain {
	/** The Claim's authority: this Conversation, at this Ownership epoch. The
	 * lease deadline is deliberately not kept — renewal moves it, so a retained
	 * copy would be stale from the first tick. */
	owner: ConversationOwner;
	/** The Claim's snapshot: the Runs to serve, in submission order. Runs
	 * submitted after the Claim are never appended here. */
	runIds: readonly string[];
	/** The Run whose runtime-shutdown signal this control loop owns. */
	served?: ActiveEntry;
	/**
	 * Why the drain stopped early, if it did. Both mean "do not release": a lost
	 * lease belongs to a successor whose ownership releasing would revoke, and a
	 * deleted Conversation has nothing left to release. Shared with the serving
	 * seam so the two layers cannot drift on the Ownership-loss vocabulary.
	 */
	halted?: OwnershipLossReason;
}

/** Map key for one Conversation; the table's key is `(user, conversation)`. */
function conversationKey(owner: ConversationOwner): string {
	return `${owner.userId}/${owner.conversationId}`;
}

const RUN_LIVENESS_SWEEP_INTERVAL_MS = 15_000;
/**
 * The agent-worker control loop over the shared queue helpers. Its unit is the
 * Conversation (ADR-0015): a worker Claims a Conversation, serves the Runs it
 * had queued at that moment one at a time in submission order, and releases.
 * One `tick`:
 *  1. expires old queued Runs whose Conversation was already unowned, then
 *     reclaims lapsed Ownership so preserved queued Runs remain available to
 *     this tick's Claim;
 *  2. renews Claims between snapshot Runs and prompts the shared Run-serving
 *     seam's active-Run heartbeats; and
 *  3. Claims Conversations up to the supervisor's remaining capacity and
 *     dispatches each as one supervised drain.
 *
 * `tick` is the whole loop and is directly awaitable, so tests drive Reclamation,
 * claim, renewal, and terminalization deterministically (PGlite + explicit
 * ticks, no wall-clock timers — Bun lacks `setInterval` fake timers). `start`
 * schedules both `tick` and the at-least-15s Run liveness sweep; `stop`
 * unschedules them and drains in-flight work.
 *
 * Ownership and single-terminalization are enforced by the DB fences in the
 * helpers, not here: two workers cannot Claim one Conversation (`FOR UPDATE
 * SKIP LOCKED`), a superseded or lapsed Claim is refused by the epoch fence, and
 * Reclamation CASes the same Active statuses as worker terminalization. This
 * loop's job is to turn those helpers into a warm, bounded-concurrency service.
 * At-most-one-executing is deliberately a program-order property here: one
 * drain awaits each snapshot Run before starting the next. The database
 * guarantees this Claim is the only writer, but no longer constrains that
 * writer to start only one Run at a time.
 */
export class RunLoop {
	private readonly drains = new Map<string, ActiveDrain>();
	private readonly runServing: RunServing;
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private runLivenessSweepTimer: ReturnType<typeof setTimeout> | undefined;
	private doorbellUnsubscribe: (() => void) | undefined;

	constructor(private readonly opts: RunLoopOptions) {
		this.runServing = createRunServing({
			db: opts.db,
			processor: opts.processor,
			liveStreamRelay: opts.liveStreamRelay,
			liveStreamTelemetry: opts.liveStreamTelemetry,
			logger: opts.logger,
		});
	}

	private get workerId(): string {
		return this.opts.worker.workerId;
	}

	/**
	 * Run one control-loop iteration: expire already-unowned queued Runs, reclaim
	 * lapsed Conversations, renew the Ownership lease of every Conversation this
	 * worker is draining, then Claim and dispatch Conversations up to capacity.
	 * Returns how many Conversations were Claimed this tick.
	 */
	async tick(): Promise<number> {
		await this.tryRunLivenessSweep();
		await this.renewDrainsWithoutActiveRuns();
		await this.runServing.heartbeat();
		return this.claimAndDrain();
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
		this.runLivenessSweepTimer = setTimeout(
			() => void this.onRunLivenessSweepTimer(),
			RUN_LIVENESS_SWEEP_INTERVAL_MS,
		);
		if (this.opts.doorbell) {
			// Rings coalesce so a burst of admissions costs one trailing claim pass,
			// and doorbell ticks never run concurrently with each other. A doorbell
			// tick MAY overlap a timer tick — that is safe: claiming is `FOR UPDATE
			// SKIP LOCKED` and renewals/terminals are fenced, so overlap costs a
			// redundant query, never a double claim.
			const ticker = new DoorbellTicker(
				async () => {
					await this.tick();
				},
				(error) => {
					this.opts.logger.error({
						message: "doorbell tick failed",
						workerId: this.workerId,
						error: toMessage(error),
					});
				},
			);
			const unsubscribe = this.opts.doorbell.subscribe(() => {
				if (this.running) ticker.ring();
			});
			this.doorbellUnsubscribe = () => {
				ticker.stop();
				unsubscribe();
			};
		}
	}

	/** Stop scheduling new ticks and drain in-flight runs via the supervisor. */
	async stop(): Promise<void> {
		this.running = false;
		if (this.doorbellUnsubscribe) {
			this.doorbellUnsubscribe();
			this.doorbellUnsubscribe = undefined;
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.runLivenessSweepTimer) {
			clearTimeout(this.runLivenessSweepTimer);
			this.runLivenessSweepTimer = undefined;
		}
		// Stop every in-flight run before draining: cancel Tool/E2B work, then
		// force-close private SDK resources without granting the user-interruption
		// grace window. `state.interrupted` stays false, so shutdown drains to
		// `error`, never a false `done`. Each drain then sees the supervisor
		// draining, stops serving its snapshot, and releases its Conversation, so
		// the Runs it never started are picked up by the next Claim instead of
		// waiting out the lease. Snapshot the map: a finishing drain deletes itself.
		for (const drain of [...this.drains.values()]) {
			drain.served?.shutdownController.abort();
		}
		await this.opts.worker.shutdown();
	}

	private async onRunLivenessSweepTimer(): Promise<void> {
		if (!this.running) return;
		try {
			await this.tryRunLivenessSweep();
		} finally {
			if (this.running) {
				this.runLivenessSweepTimer = setTimeout(
					() => void this.onRunLivenessSweepTimer(),
					RUN_LIVENESS_SWEEP_INTERVAL_MS,
				);
			}
		}
	}

	private async tryRunLivenessSweep(): Promise<void> {
		await this.tryExpireUnownedQueuedRuns();
		await this.tryReclaimConversations();
	}

	private async tryReclaimConversations(): Promise<void> {
		try {
			for (;;) {
				const reclamation = await reclaimConversationTx(this.opts.db);
				if (!reclamation) break;
				if (reclamation.runs.length > 0) {
					this.opts.logger.warn({
						message: "reclaimed Conversation",
						workerId: this.workerId,
						conversationId: reclamation.conversationId,
						reclaimedRuns: reclamation.runs.map((run) => ({
							runId: run.runId,
							status: run.status,
						})),
					});
				}
				for (const run of reclamation.runs) {
					if (run.liveStreamFailedAt === null) continue;
					if (run.liveStreamFailureMarkedByReclamation) {
						this.opts.liveStreamTelemetry?.record("degradation", "started", {
							reason: "stale_worker",
						});
					}
					this.opts.liveStreamTelemetry?.record("degradation", "ended", {
						reason: "stale_worker",
						durationMs: Math.max(
							0,
							Date.now() - run.liveStreamFailedAt.getTime(),
						),
					});
				}
			}
		} catch (error) {
			this.opts.logger.error({
				message: "Conversation Reclamation failed",
				workerId: this.workerId,
				error: toMessage(error),
			});
		}
	}

	private async tryExpireUnownedQueuedRuns(): Promise<void> {
		try {
			for (;;) {
				const expiration = await expireUnownedQueuedRunsTx(this.opts.db);
				if (!expiration) break;
				this.opts.logger.warn({
					message: "expired unowned queued Runs",
					workerId: this.workerId,
					conversationId: expiration.conversationId,
					expiredRuns: expiration.runs.map((run) => ({
						runId: run.runId,
						status: run.status,
					})),
				});
			}
		} catch (error) {
			this.opts.logger.error({
				message: "unowned queue timeout sweep failed",
				workerId: this.workerId,
				error: toMessage(error),
			});
		}
	}

	/** Preserve the Claim across start/between-Run windows. Once a Run is
	 * attached, the shared Run-serving seam is the sole renewal owner. */
	private async renewDrainsWithoutActiveRuns(): Promise<void> {
		for (const [key, drain] of [...this.drains]) {
			if (drain.served) continue;
			const renewal = await renewOwnershipLease({
				db: this.opts.db,
				owner: drain.owner,
				workerId: this.workerId,
				logger: this.opts.logger,
			});
			if (renewal.type === "retry") continue;
			// The drain may have finished and released during the round trip; from
			// there its own cleanup owns this Conversation, not the renewal loop.
			if (this.drains.get(key) !== drain) continue;
			if (renewal.type === "renewed") continue;
			this.haltDrainAfterOwnershipLoss(drain, undefined, {
				reason: "lease",
				source: "heartbeat",
			});
		}
	}

	private async claimAndDrain(): Promise<number> {
		let claimed = 0;
		while (this.opts.worker.hasCapacity) {
			const conversation = await claimConversationTx(this.opts.db, {
				workerId: this.workerId,
			});
			if (!conversation) break;
			const drain: ActiveDrain = {
				owner: {
					userId: conversation.userId,
					conversationId: conversation.conversationId,
					epoch: conversation.epoch,
				},
				runIds: conversation.runIds,
			};
			this.drains.set(conversationKey(drain.owner), drain);
			const dispatched = this.opts.worker.tryStart(() =>
				this.drainConversation(drain),
			);
			if (!dispatched) {
				// Capacity vanished between the check and the dispatch — a shutdown
				// began, or an overlapping doorbell and timer tick both saw the last
				// slot. No Run was started, so release rather than hold a lease this
				// worker cannot serve: the snapshot's Runs stay queued for the next Claim.
				this.forgetDrain(drain);
				this.opts.logger.warn({
					message: "claimed conversation not dispatched; releasing it",
					workerId: this.workerId,
					conversationId: drain.owner.conversationId,
				});
				await this.releaseConversation(drain);
				break;
			}
			claimed++;
		}
		return claimed;
	}

	/**
	 * Serve one Claimed Conversation: its snapshot Runs, one at a time in
	 * submission order, then release. Runs submitted after the Claim are
	 * deliberately left for a later Claim and never appended here — that is what
	 * bounds a drain by the admission depth bound rather than by an open-ended
	 * queue.
	 */
	private async drainConversation(drain: ActiveDrain): Promise<void> {
		try {
			for (const runId of drain.runIds) {
				// A lost lease halts the drain immediately: a successor owns this
				// Conversation and this worker must write nothing more to it. This is
				// the one place a drain stops, so a refused start only has to record
				// why.
				if (drain.halted) return;
				// Shutdown stops the drain once the Run in flight has terminalized.
				// The supervisor's own flag, not `running`: `tick()` is directly
				// awaitable without `start()`, so `running` says nothing about whether
				// this process is going away.
				if (this.opts.worker.isDraining) break;
				const started = await startClaimedRunTx(this.opts.db, {
					owner: drain.owner,
					runId,
					workerId: this.workerId,
				});
				if (started.outcome === "rejected") {
					this.noteRejectedRunWrite(drain, runId, started);
					continue;
				}
				await this.serveRun(started.run, drain);
			}
		} finally {
			this.forgetDrain(drain);
			if (!drain.halted) await this.releaseConversation(drain);
		}
	}

	/**
	 * Drop this drain's map entry. Identity-guarded because a Conversation whose
	 * lease this worker lost becomes claimable again and can be re-Claimed by the
	 * same worker while the halted drain is still unwinding; a blind delete by key
	 * would then stop renewing its successor's lease.
	 */
	private forgetDrain(drain: ActiveDrain): void {
		const key = conversationKey(drain.owner);
		if (this.drains.get(key) === drain) this.drains.delete(key);
	}

	/**
	 * Apply the drain-level meaning shared by every fenced Run write: `status`
	 * skips the write, while `lease` and `gone` halt without release.
	 */
	private noteRejectedRunWrite(
		drain: ActiveDrain,
		runId: string,
		rejection: RunWriteRejected,
	): void {
		const classified = classifyRunWriteRejection(rejection);
		if (classified.type === "status") {
			this.opts.logger.info({
				message: "skipping a Run write refused by its current status",
				workerId: this.workerId,
				conversationId: drain.owner.conversationId,
				runId,
				currentStatus: classified.current,
			});
			return;
		}
		this.haltDrainAfterOwnershipLoss(drain, runId, {
			reason: classified.reason,
			source: "write",
		});
	}

	private haltDrainAfterOwnershipLoss(
		drain: ActiveDrain,
		runId: string | undefined,
		loss: OwnershipLoss,
	): void {
		if (!drain.halted) {
			this.opts.logger.warn({
				message:
					loss.reason === "gone"
						? "stopping drain: the conversation no longer exists"
						: loss.source === "write"
							? "stopping drain: the Ownership lease is gone"
							: "halting drain after losing the Ownership lease",
				workerId: this.workerId,
				conversationId: drain.owner.conversationId,
				runId,
			});
		}
		drain.halted = loss.reason;
		this.forgetDrain(drain);
	}

	/**
	 * Give up the Claim so the Conversation is immediately claimable again rather
	 * than waiting out its lease. Only ever called by a worker that still holds
	 * it: a halted drain returns without releasing, because release by a
	 * superseded holder would revoke its successor's ownership.
	 */
	private async releaseConversation(drain: ActiveDrain): Promise<void> {
		try {
			if (await releaseConversationTx(this.opts.db, drain.owner)) return;
			this.opts.logger.warn({
				message: "ownership release matched no conversation",
				workerId: this.workerId,
				conversationId: drain.owner.conversationId,
			});
		} catch (error) {
			// The lease lapses on its own instead, and Reclamation is the backstop.
			this.opts.logger.error({
				message: "ownership release failed",
				workerId: this.workerId,
				conversationId: drain.owner.conversationId,
				error: toMessage(error),
			});
		}
	}

	private async serveRun(run: RunRecord, drain: ActiveDrain): Promise<void> {
		const entry: ActiveEntry = {
			runId: run.runId,
			shutdownController: new AbortController(),
		};
		// Attach before the first await so shutdown can reach a start that was
		// already in flight when `stop()` swept the active drains.
		drain.served = entry;
		if (this.opts.worker.isDraining) {
			entry.shutdownController.abort();
		}
		try {
			await this.runServing.serveStartedRun({
				run,
				owner: {
					...drain.owner,
					runId: run.runId,
					workerId: this.workerId,
				},
				shutdownSignal: entry.shutdownController.signal,
				onDetached: (detachment) => {
					if (drain.served === entry) drain.served = undefined;
					if (detachment.type === "ownership_lost") {
						this.haltDrainAfterOwnershipLoss(drain, run.runId, detachment);
					}
				},
			});
		} finally {
			if (drain.served === entry) drain.served = undefined;
		}
	}
}
