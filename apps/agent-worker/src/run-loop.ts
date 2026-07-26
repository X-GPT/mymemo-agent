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
	RunFenceError,
	type UserRunMutationOwner,
} from "@mymemo/agent-db/run-ownership";
import {
	appendRunEventsTx,
	claimNextRunTx,
	heartbeatRunTx,
	markLiveStreamFailedTx,
	markStaleRunsTx,
	type RunRecord,
	type TerminalOutcome,
	type TerminalRunStatus,
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

/** A processor that reports nothing is normalized to a turn with no session
 * pointer to advance (the Milestone 3 synthetic turn). */
const EMPTY_TURN: TurnResult = { disposition: "completed" };

type TerminalizationIntent =
	| Exclude<TerminalOutcome, { status: "error" }>
	| (Extract<TerminalOutcome, { status: "error" }> & {
			/** Proven continuity carried only if the error CAS must reconcile to
			 * an interrupted Outcome. It is never sent with `run_error`. */
			interruptionFallback?: { agentSessionId: string };
	  });

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
	/** A heartbeat observed `interrupt_requested`; the terminal must be `interrupted`. */
	interrupted: boolean;
	/** A heartbeat lost the ownership fence; recovery owns the run — do not
	 * terminalize it. */
	lostOwnership: boolean;
}

interface ActiveEntry {
	controller: AbortController;
	interruptionController: AbortController;
	shutdownController: AbortController;
	ownershipLostController: AbortController;
	state: RunEndState;
	liveStream?: RunLiveStream;
}

const STALE_RUN_RECOVERY_INTERVAL_MS = 15_000;
const GENERIC_RUN_ERROR_MESSAGE = "Run failed";

/**
 * The agent-worker control loop over the shared run-store helpers. One `tick`:
 *  1. terminalizes stale runs through the shared recovery helper;
 *  2. heartbeats every run this worker is executing — renewing `locked_until`
 *     and, in the same call, observing an `interrupt_requested` or a lost ownership
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
		// Stop every in-flight run before draining: cancel Tool/E2B work, then
		// force-close private SDK resources without granting the user-interruption
		// grace window. `state.interrupted` stays false, so shutdown drains to
		// `error`, never a false `done`. Snapshot the map: a finishing run deletes itself.
		for (const entry of [...this.activeRuns.values()]) {
			entry.controller.abort();
			entry.shutdownController.abort();
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
				entry.ownershipLostController.abort();
				continue;
			}
			if (renewed.status === "interrupt_requested") {
				entry.state.interrupted = true;
				entry.controller.abort();
				entry.interruptionController.abort();
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
				interruptionController: new AbortController(),
				shutdownController: new AbortController(),
				ownershipLostController: new AbortController(),
				state: { interrupted: false, lostOwnership: false },
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
					interruptionSignal: entry.interruptionController.signal,
					shutdownSignal: entry.shutdownController.signal,
					ownershipLostSignal: entry.ownershipLostController.signal,
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
		const owner: UserRunMutationOwner = {
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
			workerId: this.workerId,
		};
		if (state.lostOwnership) {
			this.opts.logger.warn({
				message: "abandoning run after ownership loss",
				workerId: this.workerId,
				runId: owner.runId,
			});
			return null;
		}
		const agentSessionId = resumableAgentSessionId(turnResult);
		// Interruption wins over both success and failure: an SDK error raised
		// while interrupting still surfaces as `interrupted`. A mirrored main
		// session publishes its first or later resume pointer with this Outcome.
		if (state.interrupted) {
			return this.terminalize(owner, {
				status: "interrupted",
				agentSessionId,
			});
		}
		if (failure) {
			return this.failRun(owner, {
				message: "run failed",
				fields: artifactFailureLogFields(failure.error),
				interruptionFallback: interruptionFallback(agentSessionId),
			});
		}
		if (turnResult.streamMetadata?.mirrorErrorObserved) {
			return this.failRun(owner, {
				message: "agent session mirror failed",
				fields: { reason: "mirror_error" },
			});
		}
		if (turnResult.disposition === "stopped") {
			return this.failRun(owner, {
				message: "run stopped before completion",
				interruptionFallback: interruptionFallback(agentSessionId),
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
				turnResult.artifactPublication,
				agentSessionId,
			);
		}
		return this.terminalize(owner, { status: "done", agentSessionId });
	}

	private failRun(
		owner: UserRunMutationOwner,
		input: {
			message: string;
			fields?: Record<string, unknown>;
			interruptionFallback?: { agentSessionId: string };
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
		return this.terminalize(owner, {
			status: "error",
			payload: { message: GENERIC_RUN_ERROR_MESSAGE },
			...(input.interruptionFallback
				? { interruptionFallback: input.interruptionFallback }
				: {}),
		});
	}

	private async publishArtifactsAndFinish(
		owner: UserRunMutationOwner,
		publication: NonNullable<TurnResult["artifactPublication"]>,
		agentSessionId: string | undefined,
	): Promise<TerminalRunStatus | null> {
		try {
			await publishArtifactsAndTransitionRunDoneTx(this.opts.db, {
				owner,
				artifacts: publication.artifacts,
				agentSessionId,
			});
			return "done";
		} catch (error) {
			if (error instanceof RunFenceError) {
				if (await this.tryTerminalInterrupted(owner, agentSessionId)) {
					return "interrupted";
				}
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
			const fallback = interruptionFallback(agentSessionId);
			return this.terminalize(owner, {
				status: "error",
				payload: { message: GENERIC_RUN_ERROR_MESSAGE },
				...(fallback ? { interruptionFallback: fallback } : {}),
			});
		}
	}

	/**
	 * Append the run's terminal event through the fenced run-store helper, with
	 * the late-interruption fallback the loop relies on: `done`/`error` lose to an
	 * interruption the terminal CAS observes (the run is already
	 * `interrupt_requested`), so on a fence rejection try `interrupted` once. An
	 * error intent can carry proven continuity only inside its explicit
	 * `interruptionFallback`; the `run_error` Outcome itself never receives it.
	 * If even `interrupted` is fenced, stale-run recovery finishes the run.
	 */
	private async terminalize(
		owner: UserRunMutationOwner,
		intent: TerminalizationIntent,
	): Promise<TerminalRunStatus | null> {
		const outcome: TerminalOutcome =
			intent.status === "error"
				? {
						status: "error",
						...(intent.payload !== undefined
							? { payload: intent.payload }
							: {}),
					}
				: intent;
		try {
			await transitionRunTerminalTx(this.opts.db, { owner, ...outcome });
			return outcome.status;
		} catch (error) {
			if (error instanceof RunFenceError) {
				if (
					outcome.status !== "interrupted" &&
					(await this.tryTerminalInterrupted(
						owner,
						intent.status === "error"
							? intent.interruptionFallback?.agentSessionId
							: intent.agentSessionId,
					))
				) {
					return "interrupted";
				}
				this.opts.logger.warn({
					message: "could not terminalize run; leaving to stale-run recovery",
					workerId: this.workerId,
					runId: owner.runId,
					intended: outcome.status,
				});
				return null;
			}
			throw error;
		}
	}

	private async tryTerminalInterrupted(
		owner: UserRunMutationOwner,
		agentSessionId?: string,
	): Promise<boolean> {
		try {
			await transitionRunTerminalTx(this.opts.db, {
				owner,
				status: "interrupted",
				agentSessionId,
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

function resumableAgentSessionId(turnResult: TurnResult): string | undefined {
	const metadata = turnResult.streamMetadata;
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

function interruptionFallback(
	agentSessionId: string | undefined,
): { agentSessionId: string } | undefined {
	return agentSessionId === undefined ? undefined : { agentSessionId };
}
