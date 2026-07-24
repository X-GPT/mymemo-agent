import {
	ArtifactQuotaError,
	type PublishedArtifact,
	publishArtifactsAndTransitionRunDoneTx,
} from "@mymemo/agent-db/artifact-store";
import type { Database } from "@mymemo/agent-db/client";
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
	claimNextRunTx,
	heartbeatRunTx,
	markLiveStreamFailedTx,
	markStaleRunsTx,
	RunFenceError,
	type RunRecord,
	type TerminalRunStatus,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";
import {
	advanceAgentSessionPointerTx,
	type RunOwnershipRef,
} from "@mymemo/agent-db/runtime-store";
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
export interface TurnResult {
	/**
	 * The agent session to record as the conversation's resume pointer once the
	 * turn terminalizes `done` (ADR-0005). Present only when the SDK produced a
	 * session id AND no `mirror_error` made the mirrored transcript unreliable —
	 * a dropped-mirror turn omits it, so the pointer does not advance yet the run
	 * still succeeds. Absent for synthetic turns that ran no query.
	 */
	agentSession?: { sessionId: string } | null;
	/** Changed files already ledgered and uploaded under fresh private keys. */
	artifactPublication?: { artifacts: PublishedArtifact[] } | null;
}

/** A processor that reports nothing is normalized to a turn with no session
 * pointer to advance (the Milestone 3 synthetic turn). */
const EMPTY_TURN: TurnResult = {};

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
 * cancellation or loses ownership, so long-running processing can stop
 * promptly.
 */
export interface RunProcessContext {
	run: RunRecord;
	signal: AbortSignal;
	appendModelContent(content: ModelContent): Promise<void>;
	/** Atomically append an ordered group of model events under one Run fence. */
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
	/** Required AG-UI relay. Runtime failures keep durable execution available. */
	liveStreamRelay: LiveStreamRelay;
	/** Payload-free Live Stream relay operation metrics. */
	liveStreamTelemetry?: LiveStreamTelemetry;
	/** How often {@link RunLoop.start}'s timer fires a tick (heartbeat + claim). */
	heartbeatIntervalMs: number;
	/** Optional doorbell whose ring triggers an immediate tick. */
	doorbell?: RunDoorbell;
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
	liveStream?: RunLiveStream;
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
	private doorbellUnsubscribe: (() => void) | undefined;

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
		for (const run of recovered) {
			if (run.liveStreamFailedAt === null) continue;
			if (run.liveStreamFailureMarkedByRecovery) {
				this.opts.liveStreamTelemetry?.record("degradation", "started", {
					reason: "stale_worker",
				});
			}
			this.opts.liveStreamTelemetry?.record("degradation", "ended", {
				reason: "stale_worker",
				durationMs: Math.max(0, Date.now() - run.liveStreamFailedAt.getTime()),
			});
		}
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
		const liveStream = await RunLiveStream.open({
			relay: this.opts.liveStreamRelay,
			runId: run.runId,
			conversationId: run.conversationId,
			markLiveStreamFailed: async () => {
				const result = await markLiveStreamFailedTx(this.opts.db, {
					runId: run.runId,
					workerId: this.workerId,
				});
				if (result.outcome === "fence_rejected") {
					this.opts.logger.warn({
						message: "could not mark Live Stream failed through Run fence",
						workerId: this.workerId,
						runId: run.runId,
					});
					throw new RunFenceError(
						"Run fence rejected the Live Stream failure marker",
					);
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
		let turnResult: TurnResult = EMPTY_TURN;
		let failure: { error: unknown } | undefined;
		try {
			turnResult =
				(await this.opts.processor({
					run,
					signal: entry.controller.signal,
					appendModelContent: (content) =>
						this.appendModelContent(run.runId, content),
					appendModelContents: (contents) =>
						this.appendModelContents(run.runId, contents),
					appendLiveEvent: (event) => liveStream.append(event),
				})) ?? EMPTY_TURN;
		} catch (error) {
			failure = { error };
		}
		// Stop heartbeating this run before terminalizing: from here the loop owns
		// the terminal transition and a concurrent heartbeat must not race it.
		this.activeRuns.delete(run.runId);
		try {
			const terminalStatus = await this.finish(
				run,
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
		runId: string,
		content: ModelContent,
	): Promise<void> {
		await this.appendModelContents(runId, [content]);
	}

	private async appendModelContents(
		runId: string,
		contents: readonly ModelContent[],
	): Promise<void> {
		await appendRunEventsTx(this.opts.db, {
			runId,
			workerId: this.workerId,
			events: contents.map((content) => ({
				type: MODEL_CONTENT_EVENT_TYPES[content.kind],
				payload: content.payload,
			})),
			appendClass: "model",
		});
	}

	private async finish(
		run: RunRecord,
		state: RunEndState,
		turnResult: TurnResult,
		failure?: { error: unknown },
	): Promise<TerminalRunStatus | null> {
		const runId = run.runId;
		if (state.lostOwnership) {
			this.opts.logger.warn({
				message: "abandoning run after ownership loss",
				workerId: this.workerId,
				runId,
			});
			return null;
		}
		// Cancellation wins over both success and failure: an SDK error raised
		// while interrupting still surfaces as `canceled`.
		if (state.canceled) {
			return this.terminalize(runId, "canceled");
		}
		if (failure) {
			this.opts.logger.error({
				message: "run failed",
				workerId: this.workerId,
				userId: run.userId,
				conversationId: run.conversationId,
				runId,
				...artifactFailureLogFields(failure.error),
			});
			return this.terminalize(runId, "error", {
				message: GENERIC_RUN_ERROR_MESSAGE,
			});
		}
		// Success: terminalize `done` directly — there is no end-of-turn
		// checkpoint (ADR-0007); the sandbox idle-pauses once renewal stops and is
		// itself the persisted workspace. The terminal-success transition also
		// advances the conversation's resume pointer, under the ownership fence
		// (ADR-0005). Only when the turn reported a session to resume from — a
		// `mirror_error` turn carries none, so the pointer holds and the run still
		// terminalizes `done`.
		const owner: RunOwnershipRef = {
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
			workerId: this.workerId,
		};
		if (turnResult.artifactPublication) {
			return this.publishArtifactsAndFinish(owner, turnResult);
		}
		if (turnResult.agentSession) {
			await this.advanceSessionPointer(
				owner,
				turnResult.agentSession.sessionId,
			);
		}
		return this.terminalize(runId, "done");
	}

	private async publishArtifactsAndFinish(
		owner: RunOwnershipRef,
		turnResult: TurnResult,
	): Promise<TerminalRunStatus | null> {
		const publication = turnResult.artifactPublication;
		if (!publication) return null;
		try {
			const result = await publishArtifactsAndTransitionRunDoneTx(
				this.opts.db,
				{
					owner,
					artifacts: publication.artifacts,
					agentSessionId: turnResult.agentSession?.sessionId,
				},
			);
			if (
				turnResult.agentSession &&
				result.agentSessionPointerAdvanced === false
			) {
				this.opts.logger.warn({
					message: "could not advance agent session pointer",
					workerId: this.workerId,
					runId: owner.runId,
				});
			}
			return "done";
		} catch (error) {
			if (error instanceof RunFenceError) {
				if (await this.tryTerminalCanceled(owner.runId)) return "canceled";
				this.opts.logger.warn({
					message: "could not publish artifacts; leaving to stale-run recovery",
					workerId: this.workerId,
					runId: owner.runId,
				});
				return null;
			}
			this.opts.logger.error({
				message: "run failed",
				workerId: this.workerId,
				userId: owner.userId,
				conversationId: owner.conversationId,
				runId: owner.runId,
				...(error instanceof ArtifactQuotaError
					? artifactFailureLogFields(error)
					: {
							error: "artifact metadata publication failed",
							artifactFailure: {
								category: "publication",
								stage: "metadata",
							},
						}),
			});
			return this.terminalize(owner.runId, "error", {
				message: GENERIC_RUN_ERROR_MESSAGE,
			});
		}
	}

	/**
	 * Advance the conversation's Claude Agent SDK resume pointer through the fenced
	 * runtime helper. Best-effort (ADR-0005): a failure — the fence lost to
	 * recovery, or a transient DB error — only leaves the next turn resuming from
	 * the previous session, losing this turn's model-side memory; the user-visible
	 * run still succeeds, so the terminal `done` must not be blocked by it.
	 */
	private async advanceSessionPointer(
		owner: RunOwnershipRef,
		agentSessionId: string,
	): Promise<void> {
		try {
			await advanceAgentSessionPointerTx(this.opts.db, {
				...owner,
				agentSessionId,
			});
		} catch (error) {
			this.opts.logger.warn({
				message: "could not advance agent session pointer",
				workerId: this.workerId,
				runId: owner.runId,
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
	): Promise<TerminalRunStatus | null> {
		try {
			await transitionRunTerminalTx(this.opts.db, {
				runId,
				workerId: this.workerId,
				status,
				payload,
			});
			return status;
		} catch (error) {
			if (error instanceof RunFenceError) {
				if (status !== "canceled" && (await this.tryTerminalCanceled(runId))) {
					return "canceled";
				}
				this.opts.logger.warn({
					message: "could not terminalize run; leaving to stale-run recovery",
					workerId: this.workerId,
					runId,
					intended: status,
				});
				return null;
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
