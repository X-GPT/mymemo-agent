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
	type UiPayloadEventPayload,
} from "@mymemo/agent-db/run-events";
import {
	appendRunEventsTx,
	loadExecutingRunTx,
	markLiveStreamFailedTx,
	type RunRecord,
	type RunWriteOwner,
	type RunWriteRejected,
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
import { renewOwnershipLease } from "./ownership-lease";
import { RunLiveStream } from "./run-live-stream";
import {
	classifyRunWriteRejection,
	type OwnershipLoss,
	type OwnershipLossReason,
} from "./run-write-rejection";

export type TurnDisposition = "completed" | "stopped";

export interface AgentStreamMetadata {
	mirrorErrorObserved: boolean;
}

export interface TurnStreamMetadata extends AgentStreamMetadata {
	/** The main session proven resumable by the bound SessionStore during this
	 * Run. Initialization and subagent mirrors do not count. */
	mirroredMainSessionId: string | null;
}

export interface TurnResult {
	/** Cause-blind processor disposition; Run serving chooses the Outcome. */
	disposition: TurnDisposition;
	/** SDK stream reliability plus continuity evidence from the SessionStore. */
	streamMetadata?: TurnStreamMetadata;
	/** Changed files already ledgered and uploaded under fresh private keys. */
	artifactPublication?: { artifacts: PublishedArtifact[] } | null;
}

const EMPTY_TURN: TurnResult = { disposition: "completed" };

/** A processor failure that retains only bounded continuity evidence for
 * terminal reconciliation. */
export class RunProcessorFailure extends Error {
	override name = "RunProcessorFailure" as const;

	constructor(
		readonly failure: unknown,
		readonly streamMetadata: TurnStreamMetadata,
	) {
		super("run processor failed");
	}
}

/** One canonical, client-safe piece of durable model content. */
export type ModelContent =
	| { kind: "assistant_message"; payload: AssistantMessageCompletedPayload }
	| { kind: "tool_call_started"; payload: ToolCallStartedPayload }
	| { kind: "tool_call_args"; payload: ToolCallArgsPayload }
	| { kind: "tool_call_completed"; payload: ToolCallCompletedPayload }
	| { kind: "tool_call_result"; payload: ToolCallResultPayload }
	| { kind: "ui_payload"; payload: UiPayloadEventPayload };

const MODEL_CONTENT_EVENT_TYPES = {
	assistant_message: RunEventType.AssistantMessageCompleted,
	tool_call_started: RunEventType.ToolCallStarted,
	tool_call_args: RunEventType.ToolCallArgs,
	tool_call_completed: RunEventType.ToolCallCompleted,
	tool_call_result: RunEventType.ToolCallResult,
	ui_payload: RunEventType.UiPayload,
} as const satisfies Record<ModelContent["kind"], RunEventType>;

export interface RunProcessContext {
	run: RunRecord;
	owner: RunWriteOwner;
	/** Cancels active Tool/E2B work for every serving stop cause. */
	signal: AbortSignal;
	/** Fires only after durable interruption is observed. */
	interruptionSignal: AbortSignal;
	/** Fires on runtime shutdown. */
	shutdownSignal: AbortSignal;
	/** Fires when this worker must immediately stop private SDK work because the
	 * Conversation fence was lost or the Run reached an Outcome elsewhere. */
	ownershipLostSignal: AbortSignal;
	appendModelContent(content: ModelContent): Promise<number>;
	appendModelContents(contents: readonly ModelContent[]): Promise<number[]>;
	/** Live Stream failure is absorbed and cannot change model execution. */
	appendLiveEvent(event: LiveStreamEvent): Promise<void>;
}

// biome-ignore lint/suspicious/noConfusingVoidType: `void` keeps a nothing-returning processor valid — `undefined` is not assignable from a void-returning async fn.
type RunTurnResult = void | TurnResult;

export type RunProcessor = (ctx: RunProcessContext) => Promise<RunTurnResult>;

export type RunServingDetachment =
	| { type: "run_detached" }
	| ({ type: "ownership_lost" } & OwnershipLoss);

export interface RunServingOptions {
	db: Database;
	processor: RunProcessor;
	liveStreamRelay: LiveStreamRelay;
	liveStreamTelemetry?: LiveStreamTelemetry;
	logger: WorkerLogger;
}

export interface ServeStartedRunInput {
	/** The durable Run row returned by the transaction that started this Run. */
	run: RunRecord;
	/** Live Conversation Ownership epoch plus Run and runtime provenance. */
	owner: RunWriteOwner;
	/** Runtime shutdown, distinct from durable user interruption. */
	shutdownSignal: AbortSignal;
	/** Lets the runtime resume drain-level renewal before terminalization or while
	 * an abandoned processor unwinds, and halt immediately on Ownership loss. A
	 * later terminal-fence rejection can report Ownership loss after detachment. */
	onDetached?: (detachment: RunServingDetachment) => void;
}

/** The complete result of serving one already-started Run. */
export type ServeStartedRunResult =
	| {
			type: "terminal";
			/** Null means another durable path already selected the Outcome. */
			status: TerminalRunStatus | null;
	  }
	| {
			type: "ownership_lost";
			reason: OwnershipLossReason;
	  }
	| {
			type: "shutdown";
			status: TerminalRunStatus | null;
	  };

interface RunEndState {
	interrupted: boolean;
	skipTerminalizationReason?: "already_terminal" | "status";
	ownershipLoss?: OwnershipLossReason;
}

interface ActiveServing {
	input: ServeStartedRunInput;
	controller: AbortController;
	interruptionController: AbortController;
	ownershipLostController: AbortController;
	state: RunEndState;
	detached: boolean;
	ownershipLossNotified: boolean;
	liveStream?: RunLiveStream;
	shutdownListener: () => void;
}

const GENERIC_RUN_ERROR_MESSAGE = "Run failed";

/** Internal control flow after a fenced append or failure-marker write rejects. */
class RunWriteRejectedError extends Error {
	override readonly name = "RunWriteRejectedError";
}

/**
 * Shared serving behavior for one already-running Run (ADR-0023). It owns the
 * Run's heartbeat, interruption observation, Live Stream, processor, durable
 * model content, terminal reconciliation, continuity evidence, and artifacts.
 * Runtime control loops retain acquisition/Claim, ordering, Reclamation, and
 * release outside this module.
 */
export interface RunServing {
	serveStartedRun(input: ServeStartedRunInput): Promise<ServeStartedRunResult>;
	/** Renew Ownership and observe interruption for every attached Run. The
	 * runtime control plane owns the timer/doorbell cadence and renews Claim
	 * windows before Run start and after this seam detaches. */
	heartbeat(): Promise<void>;
}

export function createRunServing(options: RunServingOptions): RunServing {
	return new OwnedRunServing(options);
}

class OwnedRunServing implements RunServing {
	private readonly active = new Set<ActiveServing>();

	constructor(private readonly options: RunServingOptions) {}

	async serveStartedRun(
		input: ServeStartedRunInput,
	): Promise<ServeStartedRunResult> {
		const entry = this.createEntry(input);
		this.active.add(entry);
		try {
			return await this.serveEntry(entry);
		} finally {
			this.detachRun(entry);
			input.shutdownSignal.removeEventListener("abort", entry.shutdownListener);
		}
	}

	async heartbeat(): Promise<void> {
		await Promise.all(
			[...this.active].map((entry) => this.heartbeatEntry(entry)),
		);
	}

	private createEntry(input: ServeStartedRunInput): ActiveServing {
		const controller = new AbortController();
		const shutdownListener = () =>
			controller.abort(input.shutdownSignal.reason);
		const entry: ActiveServing = {
			input,
			controller,
			interruptionController: new AbortController(),
			ownershipLostController: new AbortController(),
			state: { interrupted: false },
			detached: false,
			ownershipLossNotified: false,
			shutdownListener,
		};
		if (input.shutdownSignal.aborted) shutdownListener();
		else {
			input.shutdownSignal.addEventListener("abort", shutdownListener, {
				once: true,
			});
		}
		return entry;
	}

	private detachRun(entry: ActiveServing): void {
		if (entry.detached) return;
		entry.detached = true;
		this.active.delete(entry);
		entry.input.onDetached?.({ type: "run_detached" });
	}

	private emitOwnershipLossDetachment(
		entry: ActiveServing,
		loss: OwnershipLoss,
	): void {
		if (!entry.detached) {
			entry.detached = true;
			this.active.delete(entry);
		}
		if (entry.ownershipLossNotified) return;
		entry.ownershipLossNotified = true;
		entry.input.onDetached?.({ type: "ownership_lost", ...loss });
	}

	private heartbeatEntry(entry: ActiveServing): Promise<void> {
		if (
			!this.active.has(entry) ||
			entry.state.ownershipLoss ||
			entry.state.skipTerminalizationReason ||
			entry.input.shutdownSignal.aborted
		) {
			return Promise.resolve();
		}
		return this.performHeartbeat(entry);
	}

	private async performHeartbeat(entry: ActiveServing): Promise<void> {
		const { owner } = entry.input;
		const renewal = await renewOwnershipLease({
			db: this.options.db,
			owner,
			workerId: owner.workerId,
			logger: this.options.logger,
		});
		if (renewal.type === "retry") return;
		if (!this.active.has(entry)) return;
		if (renewal.type === "lost") {
			this.noteOwnershipLost(entry, {
				reason: "lease",
				source: "heartbeat",
			});
			return;
		}

		let observed: RunRecord | null;
		try {
			observed = await loadExecutingRunTx(this.options.db, owner);
		} catch (error) {
			this.options.logger.error({
				message: "run status observation failed",
				workerId: owner.workerId,
				runId: owner.runId,
				error: toMessage(error),
			});
			return;
		}
		if (!this.active.has(entry)) return;
		if (!observed) {
			// This Run reached its Outcome under us while the Conversation lease
			// stayed live. Stop the private SDK immediately and detach only this Run;
			// the caller may continue draining the Conversation snapshot.
			entry.state.skipTerminalizationReason = "already_terminal";
			entry.controller.abort();
			entry.ownershipLostController.abort();
			this.options.logger.warn({
				message: "abandoning a run this worker no longer owns",
				workerId: owner.workerId,
				conversationId: owner.conversationId,
				runId: owner.runId,
			});
			this.detachRun(entry);
			return;
		}
		if (observed.status === "interrupt_requested") {
			entry.state.interrupted = true;
			entry.controller.abort();
			entry.interruptionController.abort();
		}
	}

	private noteOwnershipLost(entry: ActiveServing, loss: OwnershipLoss): void {
		if (entry.state.ownershipLoss) return;
		entry.state.ownershipLoss = loss.reason;
		entry.controller.abort();
		entry.ownershipLostController.abort();
		this.options.logger.warn({
			message: "abandoning run after ownership loss",
			workerId: entry.input.owner.workerId,
			conversationId: entry.input.owner.conversationId,
			runId: entry.input.owner.runId,
			reason: loss.reason,
		});
		this.emitOwnershipLossDetachment(entry, loss);
	}

	private noteRejectedWrite(
		entry: ActiveServing,
		rejection: RunWriteRejected,
	): void {
		const classified = classifyRunWriteRejection(rejection);
		if (classified.type === "status") {
			if (classified.current === "interrupt_requested") {
				entry.state.interrupted = true;
				entry.controller.abort();
				entry.interruptionController.abort();
			} else {
				entry.state.skipTerminalizationReason = "status";
				entry.controller.abort();
				this.detachRun(entry);
			}
			this.options.logger.info({
				message: "skipping a Run write refused by its current status",
				workerId: entry.input.owner.workerId,
				conversationId: entry.input.owner.conversationId,
				runId: entry.input.owner.runId,
				currentStatus: classified.current,
			});
			return;
		}
		this.noteOwnershipLost(entry, {
			reason: classified.reason,
			source: "write",
		});
	}

	private async serveEntry(
		entry: ActiveServing,
	): Promise<ServeStartedRunResult> {
		const { run, owner, shutdownSignal } = entry.input;
		const liveStream = await RunLiveStream.open({
			relay: this.options.liveStreamRelay,
			runId: run.runId,
			conversationId: run.conversationId,
			markLiveStreamFailed: async () => {
				const result = await markLiveStreamFailedTx(this.options.db, { owner });
				if (result.outcome === "rejected") {
					this.noteRejectedWrite(entry, result);
					this.options.logger.warn({
						message:
							"could not mark Live Stream failed through Ownership fence",
						workerId: owner.workerId,
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
			logger: this.options.logger,
			telemetry: this.options.liveStreamTelemetry,
		});
		entry.liveStream = liveStream;
		if (entry.state.ownershipLoss || entry.state.skipTerminalizationReason) {
			await liveStream.close();
			return this.classifyResult(entry, null);
		}

		let turnResult: TurnResult = EMPTY_TURN;
		let failure:
			| { error: unknown; streamMetadata?: TurnStreamMetadata }
			| undefined;
		try {
			turnResult =
				(await this.options.processor({
					run,
					owner,
					signal: entry.controller.signal,
					interruptionSignal: entry.interruptionController.signal,
					shutdownSignal,
					ownershipLostSignal: entry.ownershipLostController.signal,
					appendModelContent: (content) =>
						this.appendModelContent(entry, content),
					appendModelContents: (contents) =>
						this.appendModelContents(entry, contents),
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
		// Detach before terminalizing: the drain-level loop owns renewal from here,
		// and a concurrent heartbeat must not race this Run's terminal transition.
		this.detachRun(entry);

		try {
			const terminalStatus = await this.finish(entry, turnResult, failure);
			if (terminalStatus) await liveStream.finish(terminalStatus);
			return this.classifyResult(entry, terminalStatus);
		} finally {
			await liveStream.close();
		}
	}

	private classifyResult(
		entry: ActiveServing,
		status: TerminalRunStatus | null,
	): ServeStartedRunResult {
		if (entry.state.ownershipLoss) {
			return { type: "ownership_lost", reason: entry.state.ownershipLoss };
		}
		if (entry.input.shutdownSignal.aborted) {
			return { type: "shutdown", status };
		}
		return { type: "terminal", status };
	}

	private async appendModelContent(
		entry: ActiveServing,
		content: ModelContent,
	): Promise<number> {
		const [seq] = await this.appendModelContents(entry, [content]);
		if (seq === undefined) {
			throw new Error("single model-content append returned no sequence");
		}
		return seq;
	}

	private async appendModelContents(
		entry: ActiveServing,
		contents: readonly ModelContent[],
	): Promise<number[]> {
		const result = await appendRunEventsTx(this.options.db, {
			owner: entry.input.owner,
			events: contents.map((content) => ({
				type: MODEL_CONTENT_EVENT_TYPES[content.kind],
				payload: content.payload,
			})),
			appendClass: "model",
		});
		if (result.outcome === "rejected") {
			this.noteRejectedWrite(entry, result);
			throw new RunWriteRejectedError();
		}
		return result.events.map(({ seq }) => seq);
	}

	private async finish(
		entry: ActiveServing,
		turnResult: TurnResult,
		failure?: { error: unknown; streamMetadata?: TurnStreamMetadata },
	): Promise<TerminalRunStatus | null> {
		if (entry.state.ownershipLoss) {
			return null;
		}
		if (entry.state.skipTerminalizationReason) {
			if (entry.state.skipTerminalizationReason === "status") {
				this.options.logger.info({
					message: "skipping terminal transition after status rejection",
					workerId: entry.input.owner.workerId,
					runId: entry.input.owner.runId,
				});
			}
			return null;
		}

		const agentSessionId = resumableAgentSessionId(
			failure?.streamMetadata ?? turnResult.streamMetadata,
		);
		// Interruption wins over both success and failure: an SDK error raised
		// while interrupting still surfaces as `interrupted`. A mirrored main
		// session publishes its first or later resume pointer with this Outcome.
		if (entry.state.interrupted) {
			return this.terminalize(entry, {
				status: "interrupted",
				agentSessionId,
			});
		}
		if (failure) {
			return this.failRun(entry, {
				message: "run failed",
				fields: artifactFailureLogFields(failure.error),
				interruptedAgentSessionId: agentSessionId,
			});
		}
		if (turnResult.streamMetadata?.mirrorErrorObserved) {
			return this.failRun(entry, {
				message: "agent session mirror failed",
				fields: { reason: "mirror_error" },
			});
		}
		if (turnResult.disposition === "stopped") {
			return this.failRun(entry, {
				message: "run stopped before completion",
				interruptedAgentSessionId: agentSessionId,
			});
		}
		// Success terminalizes `done` directly — there is no end-of-turn
		// checkpoint (ADR-0007); the paused sandbox is the persisted workspace.
		// The same fenced transaction publishes a usable resume pointer (ADR-0005).
		if (turnResult.artifactPublication) {
			return this.publishArtifactsAndFinish(
				entry,
				turnResult.artifactPublication,
				agentSessionId,
			);
		}
		return this.terminalize(entry, { status: "done", agentSessionId });
	}

	private async failRun(
		entry: ActiveServing,
		input: {
			message: string;
			fields?: Record<string, unknown>;
			interruptedAgentSessionId?: string;
		},
	): Promise<TerminalRunStatus | null> {
		const { owner } = entry.input;
		this.options.logger.error({
			message: input.message,
			workerId: owner.workerId,
			userId: owner.userId,
			conversationId: owner.conversationId,
			runId: owner.runId,
			...input.fields,
		});
		const outcome = {
			status: "error",
			payload: { message: GENERIC_RUN_ERROR_MESSAGE },
		} as const satisfies TerminalOutcome;
		const result = await transitionRunTerminalTx(this.options.db, {
			owner,
			...outcome,
		});
		if (result.outcome === "committed") return "error";
		return this.reconcileRejectedTerminal(entry, result, outcome.status, {
			agentSessionId: input.interruptedAgentSessionId,
		});
	}

	private async publishArtifactsAndFinish(
		entry: ActiveServing,
		publication: NonNullable<TurnResult["artifactPublication"]>,
		agentSessionId: string | undefined,
	): Promise<TerminalRunStatus | null> {
		let result: TerminalTransitionResult;
		try {
			result = await publishArtifactsAndTransitionRunDoneTx(this.options.db, {
				owner: entry.input.owner,
				artifacts: publication.artifacts,
				agentSessionId,
			});
		} catch (error) {
			return this.failRun(entry, {
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
		return this.reconcileRejectedTerminal(entry, result, "done", {
			agentSessionId,
			unresolvedMessage: "could not publish artifacts; leaving to Reclamation",
		});
	}

	/** Append a non-error terminal event through the fenced Run-store helper.
	 * A concurrent durable interruption rejects `done`, then reconciliation
	 * follows up with the one terminal transition that remains legal. */
	private async terminalize(
		entry: ActiveServing,
		outcome: Exclude<TerminalOutcome, { status: "error" }>,
	): Promise<TerminalRunStatus | null> {
		const result = await transitionRunTerminalTx(this.options.db, {
			owner: entry.input.owner,
			...outcome,
		});
		if (result.outcome === "committed") return outcome.status;
		return this.reconcileRejectedTerminal(entry, result, outcome.status, {
			agentSessionId: outcome.agentSessionId,
		});
	}

	/** Resolve a refused terminal transition. Ownership loss leaves the Run to
	 * Reclamation; an interruption status refusal is retried as `interrupted`. */
	private async reconcileRejectedTerminal(
		entry: ActiveServing,
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
			const interrupted = await transitionRunTerminalTx(this.options.db, {
				owner: entry.input.owner,
				status: "interrupted",
				agentSessionId: options.agentSessionId,
			});
			if (interrupted.outcome === "committed") return "interrupted";
			unresolved = interrupted;
		}
		this.noteRejectedWrite(entry, unresolved);
		this.options.logger.warn({
			message:
				options.unresolvedMessage ??
				"could not terminalize run; leaving to Reclamation",
			workerId: entry.input.owner.workerId,
			runId: entry.input.owner.runId,
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
	// Interruption is reconciled before mirror-failure classification, so this
	// guard is load-bearing for done, interrupted, and error→interrupted Outcomes.
	if (
		!metadata ||
		metadata.mirrorErrorObserved ||
		metadata.mirroredMainSessionId === null
	) {
		return undefined;
	}
	return metadata.mirroredMainSessionId;
}
