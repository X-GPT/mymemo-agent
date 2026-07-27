import { randomUUID } from "node:crypto";
import { type AGUIEvent, EventType } from "@ag-ui/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PublicToolName } from "@mymemo/agent-db/run-events";
import { toMessage, type WorkerLogger } from "../logger";
import type {
	AgentStreamMetadata,
	ModelContent,
	TurnDisposition,
} from "../run-loop";
import { AgUiTextStream } from "./ag-ui-text-stream";
import {
	AssistantEnvelopeProtocolError,
	AssistantMessageAssembler,
	type EnvelopeCommit,
} from "./assistant-message-assembler";
import {
	projectToolResult,
	projectToolUse,
	publicToolName,
} from "./tool-event-projection";

/**
 * The subset of the Claude Agent SDK's `Query` handle the run supervisor
 * consumes: an async stream of SDK messages plus its stop controls. The real
 * `query()` result satisfies this structurally, and tests substitute a fake
 * stream — so the supervision logic is verified without a live model (plan
 * Task 7.2: "use a fake SDK stream for deterministic unit tests").
 */
export type SupervisedQuery = AsyncIterable<SDKMessage> & {
	// The SDK returns a control receipt from `interrupt()`; supervision only
	// needs to await completion, not inspect that receipt.
	interrupt(): Promise<unknown>;
	/** Forcefully terminates the underlying CLI process and resources. */
	close(): void;
	/** Optional query-local immediate close (for example, renewal failure). */
	forceCloseSignal?: AbortSignal;
};

/**
 * Internal control flow raised when an in-flight durable append observes that
 * its query has stopped. The stream consumer converts it to the same neutral
 * `stopped` disposition as a quietly settled SDK stream.
 */
export class QueryStoppedError extends Error {
	override name = "QueryStoppedError" as const;
	constructor() {
		super("agent query stopped");
	}
}

export interface StopDeadline {
	elapsed: Promise<void>;
	cancel(): void;
}

export type StartStopDeadline = (timeoutMs: number) => StopDeadline;

const QUERY_STOP_TIMEOUT_MS = 30_000;

/** The SDK reports a run failure either by throwing or — on a clean process
 * exit — by emitting a terminal `result` message with `is_error: true`. This
 * extracts the failure text from the latter so it is not mistaken for success;
 * a normal successful result returns `null`. */
export function resultErrorText(message: SDKMessage): string | null {
	if (message.type !== "result" || !message.is_error) return null;
	const text =
		message.subtype === "success" ? message.result : message.errors.join("; ");
	return text || "agent run failed";
}

/** An SDK run failure surfaced as a terminal error `result` (not a thrown
 * stream error). Carries the SDK's failure text as the run's error message. */
export class AgentResultError extends Error {
	override name = "AgentResultError" as const;
}

/** A `mirror_error` means the SDK dropped a transcript-mirror batch (at-most-once
 * delivery). It is a fail-fast stop signal, and the stored transcript is not
 * eligible to establish or advance the resume pointer. */
export function isMirrorError(message: SDKMessage): boolean {
	return message.type === "system" && message.subtype === "mirror_error";
}

/**
 * What a settled stream reports back for supervisor reconciliation and
 * Conversation continuity (ADR-0005): its neutral disposition and whether a
 * `mirror_error` made the transcript unreliable.
 */
export interface AgentStreamOutcome extends AgentStreamMetadata {
	/** Whether the query completed itself or settled after a stop request. */
	disposition: TurnDisposition;
}

/**
 * An unstopped stream failure. The `false` literal is guaranteed by the stream
 * consumer: observing `mirror_error` requests a stop, and stopped failures
 * settle as a neutral `stopped` outcome instead.
 */
export interface AgentStreamFailure {
	disposition: "failed";
	mirrorErrorObserved: false;
	error: unknown;
}

export type AgentStreamResult = AgentStreamOutcome | AgentStreamFailure;

export interface ConsumeAgentStreamParams {
	runId?: string;
	query: SupervisedQuery;
	/** Fires only for durable interruption; grants the bounded stop window. */
	interruptionSignal: AbortSignal;
	/** Operational stops that must close immediately without a grace deadline. */
	forceCloseSignals?: readonly AbortSignal[];
	/** Fires only after the ownership fence is gone; close immediately because
	 * no private transcript drain is permitted beyond the lease. */
	ownershipLostSignal?: AbortSignal;
	/** Stops the Run-scoped Tool/E2B work before the cause-blind SDK interrupt
	 * when the stream reports a fatal transcript mirror failure. */
	abortRunScopedWork: (reason: unknown) => void;
	/** Atomically persists canonical model-content events, fenced to `running`
	 * upstream. Single events use a one-item batch. */
	appendModelContents: (contents: readonly ModelContent[]) => Promise<void>;
	/** Sequential relay-backed AG-UI publication. The bound Run producer absorbs
	 * Redis failures so this callback never changes the model Outcome. */
	appendLiveEvent?: (event: AGUIEvent) => Promise<void>;
	/** Receives the omission logs ADR-0012 requires (unknown tool names,
	 * unmatched result ids, unprojectable payloads). Optional: omissions
	 * degrade visibility, never correctness. */
	logger?: WorkerLogger;
	/** Injectable only for deterministic supervision tests. */
	startStopDeadline?: StartStopDeadline;
}

/**
 * Consume a supervised SDK query, persisting assistant text and client-safe
 * Tool lifecycle events as run content events, under the run's abort signal
 * (plan Task 7.2, ADR-0012).
 *
 * At one envelope's `message_stop`, its Assistant message is appended first;
 * Tool-only envelopes persist that message with empty text. Each projected
 * `tool_use` then commits its start/arguments/end batch before those standard
 * AG-UI events are published. A `tool_result` derives only from a complete,
 * non-replay SDK user message and matches the invocation through a provider-id
 * map that never leaves the worker. Results without a committed invocation are
 * logged and omitted; correlation is never fabricated. Omissions
 * (non-allowlisted tools, unprojectable payloads) degrade visibility only; a
 * failed append of valid Tool content fails the run exactly like Assistant
 * content.
 *
 * The moment the run is aborted or reports `mirror_error` it is no longer
 * eligible to continue, so:
 *  - the query is interrupted (once), and
 *  - any further content is ignored — never appended.
 *
 * The function resolves with a `completed`/`stopped` outcome or a typed
 * unstopped failure. Deciding the terminal status — `interrupted`, `error`, or
 * no write — belongs to the Run supervisor.
 */
export async function consumeAgentStream(
	params: ConsumeAgentStreamParams,
): Promise<AgentStreamResult> {
	const { query, interruptionSignal, appendModelContents } = params;
	const outcome: AgentStreamOutcome = {
		disposition: "completed",
		mirrorErrorObserved: false,
	};
	let liveMessageMatchesCompletion = true;
	const assembler = new AssistantMessageAssembler({
		onPartialCompleteMismatch: () => {
			liveMessageMatchesCompletion = false;
		},
	});
	const abandonOpenMessage = async (): Promise<void> => {
		assembler.abandon();
		await agUiText.abandon();
		liveMessageMatchesCompletion = true;
	};
	const appendLiveEvent = async (event: AGUIEvent): Promise<void> => {
		await params.appendLiveEvent?.(event);
	};
	const agUiText = new AgUiTextStream({ appendEvent: appendLiveEvent });

	// Provider Tool-use ids stay worker-internal. They only index the public,
	// MyMemo-generated identity needed to correlate a later Tool result.
	const toolInvocationsByUseId = new Map<
		string,
		{ tool: PublicToolName; toolCallId: string }
	>();
	const appendWhileRunning = async (
		contents: readonly ModelContent[],
	): Promise<void> => {
		if (stopRequested) throw new QueryStoppedError();
		await appendModelContents(contents);
		// The append itself is not abortable. Recheck after it settles so shutdown
		// cannot let the rest of the envelope append while the DB Run is still
		// fenced as running.
		if (stopRequested) throw new QueryStoppedError();
	};

	const commitEnvelope = async (commit: EnvelopeCommit): Promise<void> => {
		const projectedToolUses: Array<{
			providerToolUseId: string;
			tool: PublicToolName;
			argumentsJson: string;
		}> = [];
		for (const toolUse of commit.toolUses) {
			const tool = publicToolName(toolUse.name);
			if (tool === null) {
				params.logger?.warn({
					message: "tool invocation omitted: tool is not client-visible",
					runId: params.runId,
					toolName: toolUse.name,
				});
				continue;
			}
			const projected = projectToolUse(tool, toolUse.input);
			if (!projected.ok) {
				params.logger?.warn({
					message: "tool invocation omitted",
					runId: params.runId,
					tool,
					reason: projected.reason,
				});
				continue;
			}
			projectedToolUses.push({
				providerToolUseId: toolUse.id,
				tool,
				argumentsJson: JSON.stringify(projected.payload.arguments),
			});
		}

		if (commit.text !== null || projectedToolUses.length > 0) {
			await appendWhileRunning([
				{
					kind: "assistant_message",
					payload: {
						messageId: commit.messageId,
						text: commit.text?.text ?? "",
					},
				},
			]);
		}
		for (const projected of projectedToolUses) {
			const toolCallId = randomUUID();
			await appendWhileRunning([
				{
					kind: "tool_call_started",
					payload: {
						toolCallId,
						toolCallName: projected.tool,
						parentMessageId: commit.messageId,
					},
				},
				{
					kind: "tool_call_args",
					payload: { toolCallId, delta: projected.argumentsJson },
				},
				{
					kind: "tool_call_completed",
					payload: { toolCallId },
				},
			]);
			await appendLiveEvent({
				type: EventType.TOOL_CALL_START,
				toolCallId,
				toolCallName: projected.tool,
				parentMessageId: commit.messageId,
			});
			await appendLiveEvent({
				type: EventType.TOOL_CALL_ARGS,
				toolCallId,
				delta: projected.argumentsJson,
			});
			await appendLiveEvent({
				type: EventType.TOOL_CALL_END,
				toolCallId,
			});
			toolInvocationsByUseId.set(projected.providerToolUseId, {
				tool: projected.tool,
				toolCallId,
			});
		}
	};

	const appendToolResults = async (
		userMessage: Extract<SDKMessage, { type: "user" }>,
	): Promise<void> => {
		for (const block of toolResultBlocks(userMessage)) {
			const invocation =
				block.toolUseId !== null
					? toolInvocationsByUseId.get(block.toolUseId)
					: undefined;
			if (block.toolUseId === null || invocation === undefined) {
				params.logger?.warn({
					message: "tool result omitted: no appended invocation matches its id",
					runId: params.runId,
					toolUseId: block.toolUseId,
				});
				continue;
			}
			// One result per invocation: a second result for the same id is
			// unmatched, logged, and omitted.
			toolInvocationsByUseId.delete(block.toolUseId);
			const projected = projectToolResult(
				invocation.tool,
				block.content,
				block.isError,
			);
			if (!projected.ok) {
				params.logger?.warn({
					message: "tool result omitted",
					runId: params.runId,
					tool: invocation.tool,
					reason: projected.reason,
				});
				continue;
			}
			const messageId = randomUUID();
			const content = projected.payload.isError
				? "Tool failed"
				: JSON.stringify(projected.payload.result);
			await appendWhileRunning([
				{
					kind: "tool_call_result",
					payload: {
						messageId,
						toolCallId: invocation.toolCallId,
						content,
						isError: projected.payload.isError,
					},
				},
			]);
			await appendLiveEvent({
				type: EventType.TOOL_CALL_RESULT,
				messageId,
				toolCallId: invocation.toolCallId,
				content,
				role: "tool",
			});
			if (projected.payload.isError) {
				await appendLiveEvent({
					type: EventType.CUSTOM,
					name: "mymemo.tool_result_error",
					value: { messageId, toolCallId: invocation.toolCallId },
				});
			}
		}
	};

	const startStopDeadline =
		params.startStopDeadline ?? createWallClockStopDeadline;
	let stopRequested = false;
	let streamSettled = false;
	let forceClosed = false;
	let stopDeadline: StopDeadline | undefined;
	let resolveForceClosed!: () => void;
	const forceClosedPromise = new Promise<void>((resolve) => {
		resolveForceClosed = resolve;
	});
	const forceClosedResult = forceClosedPromise.then(
		() => ({ type: "force_closed" }) as const,
	);
	// These catch boundaries intentionally differ: iterator failures originate
	// in the provider stream and may repeat mirror payload detail, while
	// query.close() below is a worker-side cleanup operation.
	const reportUnexpectedStoppedStreamFailure = (error: unknown): void => {
		if (isExpectedStopError(error)) return;
		params.logger?.error({
			message: "agent query failed while stopping",
			runId: params.runId,
			// A late drain failure after mirror_error may repeat the SDK's raw
			// provider/transcript detail. The observed failure is monotonic, so
			// neither a prior interruption nor a later operational close can
			// re-enable that detail.
			...(outcome.mirrorErrorObserved ? {} : { error: toMessage(error) }),
		});
	};
	const stop = (): void => {
		if (stopRequested) return;
		stopRequested = true;
		// The Run signal has already fired, cancelling active Tool work. Invoke the
		// cause-blind SDK control next, then bound how long its stream may drain.
		void query.interrupt().catch(() => {});
		stopDeadline = startStopDeadline(QUERY_STOP_TIMEOUT_MS);
		void stopDeadline.elapsed.then(() => {
			if (streamSettled || forceClosed) return;
			params.logger?.warn({
				message: "agent query exceeded stop deadline; forcing close",
				runId: params.runId,
				stopDeadlineMs: QUERY_STOP_TIMEOUT_MS,
			});
			forceClose();
		});
	};
	const forceClose = (): void => {
		if (streamSettled || forceClosed) return;
		stopRequested = true;
		stopDeadline?.cancel();
		forceClosed = true;
		try {
			query.close();
		} catch (error) {
			// `close()` is an operational cleanup boundary, not the mirror
			// stream payload. Keep its worker-only diagnostic on every stop path.
			params.logger?.error({
				message: "agent query force-close failed",
				runId: params.runId,
				error: toMessage(error),
			});
		} finally {
			resolveForceClosed();
		}
	};
	const settleStream = (): void => {
		streamSettled = true;
		stopDeadline?.cancel();
	};
	const settleStopped = async (): Promise<AgentStreamOutcome> => {
		settleStream();
		await abandonOpenMessage();
		return { ...outcome, disposition: "stopped" };
	};
	const forceCloseSignals = params.forceCloseSignals ?? [];
	const removeAbortListeners = [
		onAbort(params.ownershipLostSignal, forceClose),
		...forceCloseSignals.map((forceCloseSignal) =>
			onAbort(forceCloseSignal, forceClose),
		),
		onAbort(interruptionSignal, stop),
	];

	try {
		const iterator = query[Symbol.asyncIterator]();
		while (true) {
			const nextMessage = Promise.resolve(iterator.next());
			const next = await Promise.race([
				nextMessage.then((result) => ({ type: "message" as const, result })),
				forceClosedResult,
			]);
			if (next.type === "force_closed") {
				// `Query.close()` is the terminal SDK cleanup boundary. Do not wait
				// indefinitely for a misbehaving iterator to acknowledge it; late
				// rejection is still retained in worker-only diagnostics.
				void nextMessage.catch(reportUnexpectedStoppedStreamFailure);
				try {
					const returned = iterator.return?.();
					if (returned) {
						void Promise.resolve(returned).catch(
							reportUnexpectedStoppedStreamFailure,
						);
					}
				} catch (error) {
					reportUnexpectedStoppedStreamFailure(error);
				}
				return settleStopped();
			}
			if (next.result.done) break;
			const message = next.result.value;
			// Track mirror reliability before the stop skip: the supervisor still
			// needs it for its pointer and Outcome decisions.
			if (isMirrorError(message)) {
				outcome.mirrorErrorObserved = true;
				params.abortRunScopedWork(new Error("agent session mirror failed"));
				stop();
				continue;
			}
			if (stopRequested) continue;
			const errorText = resultErrorText(message);
			if (errorText !== null) {
				throw new AgentResultError(errorText);
			}
			if (message.type === "assistant" && message.error) {
				throw new AgentResultError(
					`assistant response rejected: ${message.error}`,
				);
			}
			if (message.type === "user") {
				// Replay-flagged messages are resumed-transcript context from earlier
				// turns; they never create tool events in this run's history.
				if (!isReplayUserMessage(message)) {
					await appendToolResults(message);
				}
				continue;
			}
			const assembled = assembler.accept(message);
			if (assembled?.type === "partial_text") {
				await agUiText.append(assembled.messageId, assembled.text);
			} else if (assembled?.type === "message_stop") {
				if (assembled.commit.text !== null && agUiText.messageId === null) {
					await agUiText.append(
						assembled.commit.text.messageId,
						assembled.commit.text.text,
					);
				}
				if (!liveMessageMatchesCompletion) {
					throw new AssistantEnvelopeProtocolError(
						"Assistant partial text did not match its completed response",
					);
				}
				const liveMessageId = await agUiText.flushMessage();
				await commitEnvelope(assembled.commit);
				if (
					assembled.commit.text !== null &&
					liveMessageId === assembled.commit.text.messageId &&
					liveMessageMatchesCompletion
				) {
					await appendLiveEvent({
						type: EventType.TEXT_MESSAGE_END,
						messageId: liveMessageId,
					});
				}
				liveMessageMatchesCompletion = true;
			}
		}
		if (stopRequested) return settleStopped();
		settleStream();
		assembler.finish();
		return outcome;
	} catch (error) {
		if (stopRequested || error instanceof QueryStoppedError) {
			reportUnexpectedStoppedStreamFailure(error);
			return settleStopped();
		}
		settleStream();
		await abandonOpenMessage();
		return {
			disposition: "failed",
			mirrorErrorObserved: false,
			error,
		};
	} finally {
		for (const removeAbortListener of removeAbortListeners) {
			removeAbortListener();
		}
	}
}

export function onAbort(
	signal: AbortSignal | undefined,
	listener: () => void,
): () => void {
	if (!signal) return () => {};
	if (signal.aborted) listener();
	else signal.addEventListener("abort", listener, { once: true });
	return () => signal.removeEventListener("abort", listener);
}

function isExpectedStopError(error: unknown): boolean {
	return (
		error instanceof QueryStoppedError ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function createWallClockStopDeadline(timeoutMs: number): StopDeadline {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		elapsed: new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		}),
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/** The SDK marks user messages replayed from a resumed session transcript with
 * `isReplay: true`; only the non-replay variant reports this run's tool work. */
function isReplayUserMessage(
	message: Extract<SDKMessage, { type: "user" }>,
): boolean {
	return "isReplay" in message && message.isReplay === true;
}

interface SdkToolResultBlock {
	/** `null` when the block carried no usable id (omit + log upstream). */
	toolUseId: string | null;
	content: unknown;
	isError: boolean;
}

/** The `tool_result` blocks of one complete SDK user message, in block order.
 * Read defensively: the payload is provider data, not a trusted shape. */
function toolResultBlocks(
	message: Extract<SDKMessage, { type: "user" }>,
): SdkToolResultBlock[] {
	const content = message.message?.content;
	if (!Array.isArray(content)) return [];
	const blocks: SdkToolResultBlock[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as unknown as Record<string, unknown>;
		if (block.type !== "tool_result") continue;
		blocks.push({
			toolUseId:
				typeof block.tool_use_id === "string" && block.tool_use_id.length > 0
					? block.tool_use_id
					: null,
			content: block.content,
			isError: block.is_error === true,
		});
	}
	return blocks;
}
