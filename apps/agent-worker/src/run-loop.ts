import {
	ArtifactQuotaError,
	type PublishedArtifact,
	publishArtifactsAndTransitionRunDoneTx,
} from "@mymemo/agent-db/artifact-store";
import type { Database } from "@mymemo/agent-db/client";
import {
	type ConversationOwner,
	claimConversationTx,
	releaseConversationTx,
	renewConversationLeaseTx,
} from "@mymemo/agent-db/conversation-ownership";
import {
	type AssistantMessageCompletedPayload,
	RunEventType,
	type ToolCallArgsPayload,
	type ToolCallCompletedPayload,
	type ToolCallResultPayload,
	type ToolCallStartedPayload,
} from "@mymemo/agent-db/run-events";
import {
	appendRunEventsTx,
	expireUnownedQueuedRunsTx,
	type FenceRejection,
	heartbeatRunTx,
	markLiveStreamFailedTx,
	type RunRecord,
	type RunWriteOwner,
	type RunWriteRejected,
	reclaimConversationTx,
	startClaimedRunTx,
	type TerminalOutcome,
	type TerminalRunStatus,
	type TerminalTransitionResult,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";
import type {
	LiveStreamEvent,
	LiveStreamRelay,
	LiveStreamTelemetry,
} from "@mymemo/live-text";
import { ArtifactValidationError } from "./artifacts/artifact-manifest";
import { ArtifactPublicationError } from "./artifacts/artifact-publication";
import { toMessage, type WorkerLogger } from "./logger";
import { DoorbellTicker, type RunDoorbell } from "./run-doorbell";
import { RunLiveStream } from "./run-live-stream";
import type { Worker } from "./worker";

/**
 * What a processor reports back about the turn it just ran. Workspace files
 * need no end-of-turn handling (ADR-0007): the sandbox idle-pauses once the
 * turn stops renewing it, and the paused sandbox *is* the persisted workspace.
 */
export type TurnDisposition = "completed" | "stopped";

/** SDK stream reliability facts used alongside the SessionStore evidence. */
export interface AgentStreamMetadata {
	mirrorErrorObserved: boolean;
}

export interface TurnStreamMetadata extends AgentStreamMetadata {
	/** The main session proven resumable by the bound SessionStore during this
	 * Run. Initialization and subagent mirrors do not count. */
	mirroredMainSessionId: string | null;
}

export interface TurnResult {
	/** Cause-blind processor disposition; the supervisor chooses the Outcome. */
	disposition: TurnDisposition;
	/**
	 * SDK stream reliability plus continuity evidence from the bound
	 * SessionStore. The supervisor alone decides the Outcome and whether the
	 * resume pointer may advance.
	 */
	streamMetadata?: TurnStreamMetadata;
	/** Changed files already ledgered and uploaded under fresh private keys. */
	artifactPublication?: { artifacts: PublishedArtifact[] } | null;
}

/** A processor that reports nothing is normalized to a completed turn with no
 * continuity evidence or artifact publication. */
const EMPTY_TURN: TurnResult = { disposition: "completed" };

/**
 * A processor failure that still carries the turn facts needed for terminal
 * reconciliation. The loop logs the original failure but retains only these
 * bounded, worker-produced facts for its Outcome decision.
 */
export class RunProcessorFailure extends Error {
	override name = "RunProcessorFailure" as const;

	constructor(
		readonly failure: unknown,
		readonly streamMetadata: TurnStreamMetadata,
	) {
		super("run processor failed");
	}
}

/**
 * One piece of canonical durable model content a processor can record while
 * its run is `running`: a complete Assistant message or one Tool lifecycle
 * event (ADR-0012). The payload is already the client-safe shape — the loop
 * persists it verbatim under the event type its kind maps to.
 */
export type ModelContent =
	| { kind: "assistant_message"; payload: AssistantMessageCompletedPayload }
	| { kind: "tool_call_started"; payload: ToolCallStartedPayload }
	| { kind: "tool_call_args"; payload: ToolCallArgsPayload }
	| { kind: "tool_call_completed"; payload: ToolCallCompletedPayload }
	| { kind: "tool_call_result"; payload: ToolCallResultPayload };

/** The loop owns the kind→event-type mapping in exactly one place, so a
 * processor can never write a payload under a mismatched vocabulary type. */
const MODEL_CONTENT_EVENT_TYPES = {
	assistant_message: RunEventType.AssistantMessageCompleted,
	tool_call_started: RunEventType.ToolCallStarted,
	tool_call_args: RunEventType.ToolCallArgs,
	tool_call_completed: RunEventType.ToolCallCompleted,
	tool_call_result: RunEventType.ToolCallResult,
} as const satisfies Record<ModelContent["kind"], RunEventType>;

/**
 * What a claimed run's processing is handed. `appendModelContent` is the bound
 * durable model-content append for this owned run (fenced by the run store to
 * `running`, all kinds alike); `signal` fires when the loop observes
 * interruption or loses ownership, so long-running processing can stop
 * promptly.
 */
export interface RunProcessContext {
	run: RunRecord;
	/** Cancels active Tool/E2B work for every supervisor stop cause. */
	signal: AbortSignal;
	/** Fires only after durable interruption is observed; grants the bounded
	 * private SDK stop window while the ownership lease remains live. */
	interruptionSignal: AbortSignal;
	/** Fires on worker shutdown; private SDK resources must close immediately. */
	shutdownSignal: AbortSignal;
	/** Fires only when the ownership fence is lost. Unlike a normal stop, this
	 * permits no post-fence drain and must close private SDK resources now. */
	ownershipLostSignal: AbortSignal;
	appendModelContent(content: ModelContent): Promise<void>;
	/** Atomically append an ordered group under one Ownership epoch fence. */
	appendModelContents(contents: readonly ModelContent[]): Promise<void>;
	/** Append one standard event to this Run's Live Stream. Failure is
	 * absorbed by the producer so it cannot change model execution. */
	appendLiveEvent(event: LiveStreamEvent): Promise<void>;
}

/**
 * Produces one claimed run's turn. Injected so the control loop's
 * claim/heartbeat/terminalize behavior is tested independently of what a turn
 * does.
 *
 * A processor may return a {@link TurnResult} with mirror reliability and
 * SessionStore evidence; the supervisor alone decides whether that evidence
 * may advance continuity. Returning nothing is treated as a completed turn
 * with no continuity evidence or artifact publication.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` keeps a nothing-returning processor valid — `undefined` is not assignable from a void-returning async fn.
type RunTurnResult = void | TurnResult;

export type RunProcessor = (ctx: RunProcessContext) => Promise<RunTurnResult>;

export interface RunLoopOptions {
	db: Database;
	worker: Worker;
	processor: RunProcessor;
	/** Required AG-UI relay. Runtime failures keep durable execution available. */
	liveStreamRelay: LiveStreamRelay;
	/** Payload-free Live Stream relay operation metrics. */
	liveStreamTelemetry?: LiveStreamTelemetry;
	/** How often {@link RunLoop.start}'s timer fires a tick (lease renewal + Claim). */
	heartbeatIntervalMs: number;
	/** Optional doorbell whose ring triggers an immediate tick. */
	doorbell?: RunDoorbell;
	logger: WorkerLogger;
}

/** Per-run loop-local state, resolved once processing ends into a terminal. */
interface RunEndState {
	/** A heartbeat observed `interrupt_requested`; the terminal must be `interrupted`. */
	interrupted: boolean;
	/** A fenced write found that another path already chose a non-interruption
	 * status, so this worker must not attempt another terminal transition. */
	skipTerminalization: boolean;
	/** A heartbeat lost the ownership fence; Reclamation owns the Run — do not
	 * terminalize it. */
	lostOwnership: boolean;
}

interface ActiveEntry {
	runId: string;
	controller: AbortController;
	interruptionController: AbortController;
	shutdownController: AbortController;
	ownershipLostController: AbortController;
	state: RunEndState;
	liveStream?: RunLiveStream;
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
	/**
	 * The Run a tick may renew and interrupt — set for exactly as long as that is
	 * true. {@link RunLoop.detachServedRun} is the only thing that clears it, and
	 * doing so is the load-bearing act that hands the Run back: before the
	 * terminal transition, so a concurrent tick cannot race the Outcome, and on
	 * abandonment, so later ticks stop heartbeating a Run that is no longer this
	 * worker's.
	 */
	served?: ActiveEntry;
	/**
	 * Why the drain stopped early, if it did. Both mean "do not release": a lost
	 * lease belongs to a successor whose ownership releasing would revoke, and a
	 * deleted Conversation has nothing left to release. Spelled as the fence
	 * vocabulary minus the one rejection that does *not* stop a drain, so the two
	 * cannot drift.
	 */
	halted?: Exclude<FenceRejection["rejected"], "status">;
}

/** Map key for one Conversation; the table's key is `(user, conversation)`. */
function conversationKey(owner: ConversationOwner): string {
	return `${owner.userId}/${owner.conversationId}`;
}

const RUN_LIVENESS_SWEEP_INTERVAL_MS = 15_000;
const GENERIC_RUN_ERROR_MESSAGE = "Run failed";

/** Internal control-flow signal: the typed rejection has already been applied
 * to the drain state, so it must stop the processor without being mistaken for
 * an SDK/model failure that deserves an `error` Outcome. */
class RunWriteRejectedError extends Error {
	override readonly name = "RunWriteRejectedError";
}

/**
 * The agent-worker control loop over the shared queue helpers. Its unit is the
 * Conversation (ADR-0015): a worker Claims a Conversation, serves the Runs it
 * had queued at that moment one at a time in submission order, and releases.
 * One `tick`:
 *  1. expires old queued Runs whose Conversation was already unowned, then
 *     reclaims lapsed Ownership so preserved queued Runs remain available to
 *     this tick's Claim;
 *  2. renews each owned Conversation's Ownership lease — a renewal matching zero
 *     rows is the lost-lease signal — and observes a durable interruption of the
 *     Run being served; and
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
 * Reclamation CASes the same Active statuses as worker terminalization. This loop's
 * job is to turn those helpers into a warm, bounded-concurrency service.
 */
export class RunLoop {
	private readonly drains = new Map<string, ActiveDrain>();
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private runLivenessSweepTimer: ReturnType<typeof setTimeout> | undefined;
	private doorbellUnsubscribe: (() => void) | undefined;

	constructor(private readonly opts: RunLoopOptions) {}

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
		await this.renewOwnedConversations();
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
			// SKIP LOCKED` and heartbeats/terminals are fenced, so overlap costs a
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
			drain.served?.controller.abort();
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

	private async renewOwnedConversations(): Promise<void> {
		// Snapshot: a drain finishing mid-iteration removes itself from the map.
		for (const [key, drain] of [...this.drains]) {
			let ownerUntil: Date | null;
			try {
				ownerUntil = await renewConversationLeaseTx(this.opts.db, drain.owner);
			} catch (error) {
				// Transient DB error: drop this Conversation's whole beat — the
				// renewal and the served Run's interruption observation alike, since a
				// database that just refused one is unlikely to answer the other. The
				// next tick retries well before the 60s Ownership deadline actually
				// lapses, so this is a dropped beat, not an abandoned Conversation.
				this.opts.logger.error({
					message: "ownership lease renewal failed",
					workerId: this.workerId,
					conversationId: drain.owner.conversationId,
					error: toMessage(error),
				});
				continue;
			}
			// The drain may have finished and released during the round trip; from
			// there its own cleanup owns this Conversation, not the renewal loop.
			if (this.drains.get(key) !== drain) continue;
			if (!ownerUntil) {
				this.loseOwnership(drain);
				continue;
			}
			await this.observeServedRun(drain);
		}
	}

	/**
	 * A renewal that matched zero rows is the lost-lease signal: either a
	 * successor Claimed this Conversation, or the lease lapsed and Reclamation
	 * owns its Runs. Halt the drain and abandon the Run in flight — and
	 * deliberately do **not** release, which would revoke the successor's
	 * ownership.
	 *
	 * Abandonment stops in-memory work promptly; the epoch fence is the durable
	 * backstop for a write already racing this signal. A terminal transition that
	 * detached just before renewal observed the loss still carries the old epoch
	 * and is therefore rejected rather than committing under a successor's Claim.
	 */
	private loseOwnership(drain: ActiveDrain): void {
		drain.halted = "lease";
		// Stop renewing a Conversation that is no longer ours. In the ordinary case
		// the drain's own cleanup removes this entry instead.
		this.forgetDrain(drain);
		this.opts.logger.warn({
			message: "halting drain after losing the Ownership lease",
			workerId: this.workerId,
			conversationId: drain.owner.conversationId,
			runId: drain.served?.runId,
		});
		this.abandonServedRun(drain);
	}

	/**
	 * Renew the served Run's legacy Run lease and observe a durable interruption.
	 *
	 * Bridge, deleted with the Run lease itself (#402). Ownership renewal above is
	 * the authority; this temporary heartbeat remains for the Conversation-scoped
	 * stores moving in #401. It also returns the served Run's status, which the
	 * drain still needs because
	 * Conversation-scoped renewal returns no Run row.
	 */
	private async observeServedRun(drain: ActiveDrain): Promise<void> {
		const served = drain.served;
		if (!served) return;
		let renewed: RunRecord | null;
		try {
			renewed = await heartbeatRunTx(this.opts.db, {
				runId: served.runId,
				workerId: this.workerId,
			});
		} catch (error) {
			this.opts.logger.error({
				message: "run heartbeat failed",
				workerId: this.workerId,
				runId: served.runId,
				error: toMessage(error),
			});
			return;
		}
		if (!renewed) {
			// This Run reached its Outcome under us while the Conversation lease
			// stayed live. It is no longer ours to terminalize, but the Conversation
			// still is, so only the Run is
			// abandoned and the drain continues with the rest of its snapshot.
			this.opts.logger.warn({
				message: "abandoning a run this worker no longer owns",
				workerId: this.workerId,
				conversationId: drain.owner.conversationId,
				runId: served.runId,
			});
			this.abandonServedRun(drain);
			return;
		}
		if (renewed.status === "interrupt_requested") {
			served.state.interrupted = true;
			served.controller.abort();
			served.interruptionController.abort();
		}
	}

	/**
	 * Hand the Run in flight back from the tick loop, so no later tick renews or
	 * interrupts it. The only writer of `drain.served`, because forgetting to
	 * detach is silent: the Run keeps being heartbeated, and a terminal
	 * transition can race a tick that still believes it owns it.
	 */
	private detachServedRun(drain: ActiveDrain): ActiveEntry | undefined {
		const served = drain.served;
		drain.served = undefined;
		return served;
	}

	/**
	 * Stop serving the Run in flight without terminalizing it: its Outcome
	 * belongs to whoever holds it now. `finish()` still reads `lostOwnership`
	 * through the detached entry and skips the terminal transition.
	 */
	private abandonServedRun(drain: ActiveDrain): void {
		const served = this.detachServedRun(drain);
		if (!served) return;
		served.state.lostOwnership = true;
		served.controller.abort();
		served.ownershipLostController.abort();
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
		if (rejection.rejected === "status") {
			this.opts.logger.info({
				message: "skipping a Run write refused by its current status",
				workerId: this.workerId,
				conversationId: drain.owner.conversationId,
				runId,
				currentStatus: rejection.current,
			});
			return;
		}
		drain.halted = rejection.rejected;
		this.opts.logger.warn({
			message:
				rejection.rejected === "gone"
					? "stopping drain: the conversation no longer exists"
					: "stopping drain: the Ownership lease is gone",
			workerId: this.workerId,
			conversationId: drain.owner.conversationId,
			runId,
		});
	}

	/** Apply a rejection to the Run currently executing, then record its
	 * drain-level meaning through {@link noteRejectedRunWrite}. */
	private noteRejectedActiveRunWrite(
		drain: ActiveDrain,
		entry: ActiveEntry,
		rejection: RunWriteRejected,
	): void {
		if (rejection.rejected === "status") {
			if (rejection.current === "interrupt_requested") {
				entry.state.interrupted = true;
				entry.controller.abort();
				entry.interruptionController.abort();
			} else {
				entry.state.skipTerminalization = true;
				entry.controller.abort();
			}
		} else {
			entry.state.lostOwnership = true;
			entry.controller.abort();
			entry.ownershipLostController.abort();
		}
		this.noteRejectedRunWrite(drain, entry.runId, rejection);
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
			controller: new AbortController(),
			interruptionController: new AbortController(),
			shutdownController: new AbortController(),
			ownershipLostController: new AbortController(),
			state: {
				interrupted: false,
				skipTerminalization: false,
				lostOwnership: false,
			},
		};
		// Attached before the first await, so a concurrent tick can renew this
		// Run's lease and hand it an observed interruption for its whole life.
		drain.served = entry;
		if (this.opts.worker.isDraining) {
			// Shutdown swept the drains before this Run reached the map — its start
			// was already in flight when `stop()` ran. Abort it at birth so it takes
			// the same path an in-flight Run does instead of running out the grace
			// period unsupervised.
			entry.controller.abort();
			entry.shutdownController.abort();
		}
		try {
			await this.executeServedRun(run, drain, entry);
		} finally {
			// Backstop: `executeServedRun` detaches the Run itself before
			// terminalizing, so this only fires on a path that unwound first.
			this.detachServedRun(drain);
		}
	}

	private async executeServedRun(
		run: RunRecord,
		drain: ActiveDrain,
		entry: ActiveEntry,
	): Promise<void> {
		const owner: RunWriteOwner = {
			...drain.owner,
			runId: run.runId,
			workerId: this.workerId,
		};
		const liveStream = await RunLiveStream.open({
			relay: this.opts.liveStreamRelay,
			runId: run.runId,
			conversationId: run.conversationId,
			markLiveStreamFailed: async () => {
				const result = await markLiveStreamFailedTx(this.opts.db, {
					owner,
				});
				if (result.outcome === "rejected") {
					this.noteRejectedActiveRunWrite(drain, entry, result);
					this.opts.logger.warn({
						message:
							"could not mark Live Stream failed through Ownership fence",
						workerId: this.workerId,
						runId: run.runId,
						rejected: result.rejected,
					});
					throw new RunWriteRejectedError();
				}
				if (result.run.liveStreamFailedAt === null) {
					throw new Error("Live Stream failure marker timestamp is missing");
				}
				return {
					outcome: result.outcome,
					failedAt: result.run.liveStreamFailedAt,
				};
			},
			logger: this.opts.logger,
			telemetry: this.opts.liveStreamTelemetry,
		});
		entry.liveStream = liveStream;
		if (entry.state.lostOwnership || entry.state.skipTerminalization) {
			await liveStream.close();
			return;
		}
		let turnResult: TurnResult = EMPTY_TURN;
		let failure:
			| { error: unknown; streamMetadata?: TurnStreamMetadata }
			| undefined;
		try {
			turnResult =
				(await this.opts.processor({
					run,
					signal: entry.controller.signal,
					interruptionSignal: entry.interruptionController.signal,
					shutdownSignal: entry.shutdownController.signal,
					ownershipLostSignal: entry.ownershipLostController.signal,
					appendModelContent: (content) =>
						this.appendModelContent(owner, drain, entry, content),
					appendModelContents: (contents) =>
						this.appendModelContents(owner, drain, entry, contents),
					appendLiveEvent: (event) => liveStream.append(event),
				})) ?? EMPTY_TURN;
		} catch (error) {
			if (!(error instanceof RunWriteRejectedError)) {
				failure =
					error instanceof RunProcessorFailure
						? {
								error: error.failure,
								streamMetadata: error.streamMetadata,
							}
						: { error };
			}
		}
		// Detach before terminalizing: from here the drain owns the terminal
		// transition and a concurrent tick must not race it.
		this.detachServedRun(drain);
		try {
			const terminalStatus = await this.finish(
				owner,
				drain,
				entry.state,
				turnResult,
				failure,
			);
			if (terminalStatus) await liveStream.finish(terminalStatus);
		} finally {
			await liveStream.close();
		}
	}

	private async appendModelContent(
		owner: RunWriteOwner,
		drain: ActiveDrain,
		entry: ActiveEntry,
		content: ModelContent,
	): Promise<void> {
		await this.appendModelContents(owner, drain, entry, [content]);
	}

	private async appendModelContents(
		owner: RunWriteOwner,
		drain: ActiveDrain,
		entry: ActiveEntry,
		contents: readonly ModelContent[],
	): Promise<void> {
		const result = await appendRunEventsTx(this.opts.db, {
			owner,
			events: contents.map((content) => ({
				type: MODEL_CONTENT_EVENT_TYPES[content.kind],
				payload: content.payload,
			})),
			appendClass: "model",
		});
		if (result.outcome === "rejected") {
			this.noteRejectedActiveRunWrite(drain, entry, result);
			throw new RunWriteRejectedError();
		}
	}

	private async finish(
		owner: RunWriteOwner,
		drain: ActiveDrain,
		state: RunEndState,
		turnResult: TurnResult,
		failure?: { error: unknown; streamMetadata?: TurnStreamMetadata },
	): Promise<TerminalRunStatus | null> {
		if (state.lostOwnership) {
			this.opts.logger.warn({
				message: "abandoning run after ownership loss",
				workerId: this.workerId,
				runId: owner.runId,
			});
			return null;
		}
		if (state.skipTerminalization) {
			this.opts.logger.info({
				message: "skipping terminal transition after status rejection",
				workerId: this.workerId,
				runId: owner.runId,
			});
			return null;
		}
		const agentSessionId = resumableAgentSessionId(
			failure?.streamMetadata ?? turnResult.streamMetadata,
		);
		// Interruption wins over both success and failure: an SDK error raised
		// while interrupting still surfaces as `interrupted`. A mirrored main
		// session publishes its first or later resume pointer with this Outcome.
		if (state.interrupted) {
			return this.terminalize(owner, drain, {
				status: "interrupted",
				agentSessionId,
			});
		}
		if (failure) {
			return this.failRun(owner, drain, {
				message: "run failed",
				fields: artifactFailureLogFields(failure.error),
				interruptedAgentSessionId: agentSessionId,
			});
		}
		if (turnResult.streamMetadata?.mirrorErrorObserved) {
			return this.failRun(owner, drain, {
				message: "agent session mirror failed",
				fields: { reason: "mirror_error" },
			});
		}
		if (turnResult.disposition === "stopped") {
			return this.failRun(owner, drain, {
				message: "run stopped before completion",
				interruptedAgentSessionId: agentSessionId,
			});
		}
		// Success: terminalize `done` directly — there is no end-of-turn
		// checkpoint (ADR-0007); the sandbox idle-pauses once renewal stops and is
		// itself the persisted workspace. The terminal-success transition also
		// publishes the conversation's first or later usable resume pointer in
		// that same ownership-fenced transaction (ADR-0005).
		if (turnResult.artifactPublication) {
			return this.publishArtifactsAndFinish(
				owner,
				drain,
				turnResult.artifactPublication,
				agentSessionId,
			);
		}
		return this.terminalize(owner, drain, { status: "done", agentSessionId });
	}

	private async failRun(
		owner: RunWriteOwner,
		drain: ActiveDrain,
		input: {
			message: string;
			fields?: Record<string, unknown>;
			interruptedAgentSessionId?: string;
		},
	): Promise<TerminalRunStatus | null> {
		this.opts.logger.error({
			message: input.message,
			workerId: this.workerId,
			userId: owner.userId,
			conversationId: owner.conversationId,
			runId: owner.runId,
			...input.fields,
		});
		const outcome = {
			status: "error",
			payload: { message: GENERIC_RUN_ERROR_MESSAGE },
		} as const satisfies TerminalOutcome;
		const result = await transitionRunTerminalTx(this.opts.db, {
			owner,
			...outcome,
		});
		if (result.outcome === "committed") return "error";
		return this.reconcileRejectedTerminal(
			owner,
			drain,
			result,
			outcome.status,
			{
				agentSessionId: input.interruptedAgentSessionId,
			},
		);
	}

	private async publishArtifactsAndFinish(
		owner: RunWriteOwner,
		drain: ActiveDrain,
		publication: NonNullable<TurnResult["artifactPublication"]>,
		agentSessionId: string | undefined,
	): Promise<TerminalRunStatus | null> {
		let result: TerminalTransitionResult;
		try {
			result = await publishArtifactsAndTransitionRunDoneTx(this.opts.db, {
				owner,
				artifacts: publication.artifacts,
				agentSessionId,
			});
		} catch (error) {
			return this.failRun(owner, drain, {
				message: "run failed",
				fields:
					error instanceof ArtifactQuotaError
						? artifactFailureLogFields(error)
						: {
								error: "artifact metadata publication failed",
								artifactFailure: {
									category: "publication",
									stage: "metadata",
								},
							},
				interruptedAgentSessionId: agentSessionId,
			});
		}
		if (result.outcome === "committed") return "done";
		return this.reconcileRejectedTerminal(owner, drain, result, "done", {
			agentSessionId,
			unresolvedMessage: "could not publish artifacts; leaving to Reclamation",
		});
	}

	/**
	 * Append a non-error terminal event through the fenced run-store helper.
	 * `done` loses to an interruption the fence observes (the Run is already
	 * `interrupt_requested`), which the rejection says outright, so the loop
	 * follows up with exactly the one legal terminal instead of guessing.
	 */
	private async terminalize(
		owner: RunWriteOwner,
		drain: ActiveDrain,
		outcome: Exclude<TerminalOutcome, { status: "error" }>,
	): Promise<TerminalRunStatus | null> {
		const result = await transitionRunTerminalTx(this.opts.db, {
			owner,
			...outcome,
		});
		if (result.outcome === "committed") return outcome.status;
		return this.reconcileRejectedTerminal(
			owner,
			drain,
			result,
			outcome.status,
			{
				agentSessionId: outcome.agentSessionId,
			},
		);
	}

	/**
	 * Resolve a refused terminal transition. A lost lease is final — Reclamation
	 * owns the Run and must not be raced. A status refusal means a durable
	 * interruption landed while the lease is still live, and `interrupted` is the
	 * one terminal that remains legal; a live lease is exactly what makes that
	 * follow-up worth attempting. Both are ordinary outcomes, so only genuine
	 * database failures propagate from here.
	 */
	private async reconcileRejectedTerminal(
		owner: RunWriteOwner,
		drain: ActiveDrain,
		rejection: RunWriteRejected,
		intended: TerminalRunStatus,
		options: {
			agentSessionId?: string;
			unresolvedMessage?: string;
		} = {},
	): Promise<TerminalRunStatus | null> {
		let unresolved = rejection;
		if (
			rejection.rejected === "status" &&
			rejection.current === "interrupt_requested"
		) {
			const interrupted = await transitionRunTerminalTx(this.opts.db, {
				owner,
				status: "interrupted",
				agentSessionId: options.agentSessionId,
			});
			if (interrupted.outcome === "committed") return "interrupted";
			// Report why the follow-up failed, not why the first attempt did.
			unresolved = interrupted;
		}
		this.noteRejectedRunWrite(drain, owner.runId, unresolved);
		this.opts.logger.warn({
			message:
				options.unresolvedMessage ??
				"could not terminalize run; leaving to Reclamation",
			workerId: this.workerId,
			runId: owner.runId,
			intended,
			rejected: unresolved.rejected,
			...(unresolved.rejected === "status"
				? { currentStatus: unresolved.current }
				: {}),
		});
		return null;
	}
}

function artifactFailureLogFields(error: unknown): Record<string, unknown> {
	if (error instanceof ArtifactQuotaError) {
		return {
			error: error.message,
			artifactFailure: {
				category: "quota",
				quota: error.quota,
				actual: error.actual,
				limit: error.limit,
			},
		};
	}
	if (error instanceof ArtifactValidationError) {
		return {
			error: error.message,
			artifactFailure: {
				category: "validation",
				reason: error.code,
			},
		};
	}
	if (error instanceof ArtifactPublicationError) {
		return {
			error: error.message,
			artifactFailure: {
				category: "publication",
				stage: error.stage,
			},
		};
	}
	return { error: toMessage(error) };
}

function resumableAgentSessionId(
	metadata: TurnStreamMetadata | undefined,
): string | undefined {
	// Keep pointer safety local to this injected RunProcessor seam. Interruption
	// is reconciled before mirror-failure classification, so this guard is
	// load-bearing for done, interrupted, and error→interrupted reconciliation.
	if (
		!metadata ||
		metadata.mirrorErrorObserved ||
		metadata.mirroredMainSessionId === null
	) {
		return undefined;
	}
	return metadata.mirroredMainSessionId;
}
