import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PublicToolName } from "@mymemo/agent-db/run-events";
import type { LiveTextPublisher } from "@mymemo/live-text";
import type { WorkerLogger } from "../logger";
import type { ModelContent } from "../run-loop";
import {
	AssistantMessageAssembler,
	type EnvelopeCommit,
} from "./assistant-message-assembler";
import {
	LiveTextPreview,
	type LiveTextPreviewSignal,
} from "./live-text-preview";
import {
	projectToolResult,
	projectToolUse,
	publicToolName,
} from "./tool-event-projection";

/**
 * The subset of the Claude Agent SDK's `Query` handle the run supervisor
 * consumes: an async stream of SDK messages plus `interrupt()`. The real
 * `query()` result satisfies this structurally, and tests substitute a fake
 * stream — so the supervision logic is verified without a live model (plan
 * Task 7.2: "use a fake SDK stream for deterministic unit tests").
 */
export type SupervisedQuery = AsyncIterable<SDKMessage> & {
	interrupt(): Promise<void>;
};

/**
 * The run was interrupted (user cancel, ownership loss, or worker shutdown) and
 * the SDK stream ended without raising. Thrown so the supervisor never records a
 * clean `done` for work that did not complete on its own; the terminal
 * transition remaps a user cancel to `canceled` and leaves the rest as `error`.
 */
export class QueryInterruptedError extends Error {
	override name = "QueryInterruptedError" as const;
	constructor() {
		super("agent query interrupted");
	}
}

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

/** The session id the worker should store as the conversation's resume pointer:
 * the id on the terminal `result` message (verify note: "the worker always
 * stores the id from the result message"), or `null` on any other message. */
export function sessionIdFromResult(message: SDKMessage): string | null {
	return message.type === "result" && typeof message.session_id === "string"
		? message.session_id
		: null;
}

/** A `mirror_error` means the SDK dropped a transcript-mirror batch (at-most-once
 * delivery). If one occurred anywhere in the run, the resume pointer must not
 * advance — the stored transcript is missing entries. */
export function isMirrorError(message: SDKMessage): boolean {
	return message.type === "system" && message.subtype === "mirror_error";
}

/**
 * What a completed stream reports back for conversation continuity (ADR-0005):
 * the session id to store as the resume pointer, and whether a `mirror_error`
 * made the mirrored transcript unreliable. Only meaningful on the clean-completion
 * path — an interrupted or errored run never advances the pointer.
 */
export interface AgentStreamOutcome {
	/** The id from the terminal result message, or `null` if none was seen. */
	sessionId: string | null;
	/** A transcript-mirror batch was dropped; do not advance the pointer. */
	mirrorErrorObserved: boolean;
}

export interface ConsumeAgentStreamParams {
	runId?: string;
	query: SupervisedQuery;
	/** Fires on cancel, ownership loss, or shutdown; interrupts the query. */
	signal: AbortSignal;
	/** Persists one piece of model content — an Assistant message, a Tool
	 * invocation, or a Tool result (fenced to `running` upstream). */
	appendModelContent: (content: ModelContent) => Promise<void>;
	/** Receives the omission logs ADR-0009 requires (unknown tool names,
	 * unmatched result ids, unprojectable payloads). Optional: omissions
	 * degrade visibility, never correctness. */
	logger?: WorkerLogger;
	liveTextPublisher?: LiveTextPublisher;
	liveTextCoalesceWindowMs?: number;
	/** Payload-free, fixed-vocabulary Live preview transport signal. */
	onLiveTextSignal?: (signal: LiveTextPreviewSignal) => void;
	/** Payload-free signal that disables Live preview for the rest of the Run. */
	onPartialCompleteMismatch?: () => void;
}

/**
 * Consume a supervised SDK query, persisting assistant text and client-safe
 * tool events as run content events, under the run's abort signal (plan Task
 * 7.2, ADR-0009).
 *
 * At one envelope's `message_stop`, its single Assistant message (when it has
 * visible text) is appended first, then its `tool_use` events in content-block
 * order. A `tool_result` derives only from a complete, non-replay SDK user
 * message, associated to its invocation through a per-run in-memory id map —
 * results for ids with no appended invocation are logged and omitted, and a
 * result is never fabricated. Omissions (non-allowlisted tools, unprojectable
 * payloads) degrade visibility only; a failed append of a valid tool event
 * fails the run exactly like assistant text.
 *
 * The moment the run is aborted it is no longer `running`, so:
 *  - the query is interrupted (once), and
 *  - any further content is ignored — never appended.
 *
 * The function resolves with the run's {@link AgentStreamOutcome} only when the
 * stream completes on its own; it throws on an SDK error (so the supervisor
 * terminalizes `error`) and on an interrupted-then-quietly-ended stream
 * ({@link QueryInterruptedError}) so an interrupted turn is never mistaken for a
 * clean success. Deciding the terminal status — `canceled` vs `error` — belongs
 * to the supervisor, which knows whether the abort was a user cancel.
 */
export async function consumeAgentStream(
	params: ConsumeAgentStreamParams,
): Promise<AgentStreamOutcome> {
	const { query, signal, appendModelContent } = params;
	const outcome: AgentStreamOutcome = {
		sessionId: null,
		mirrorErrorObserved: false,
	};
	const assembler = new AssistantMessageAssembler({
		onPartialCompleteMismatch: () => {
			preview?.disable();
			try {
				params.onPartialCompleteMismatch?.();
			} catch {
				// Telemetry is optional and cannot change the Run outcome.
			}
		},
	});
	const preview =
		params.liveTextPublisher && params.runId
			? new LiveTextPreview({
					runId: params.runId,
					publisher: params.liveTextPublisher,
					coalesceWindowMs: params.liveTextCoalesceWindowMs,
					onSignal: params.onLiveTextSignal,
				})
			: undefined;
	const abandonOpenMessage = () => {
		assembler.abandon();
		preview?.abandon();
	};

	// Worker-internal association from SDK tool-use id to public tool name,
	// established only when the invocation's event is appended — so a result for
	// an omitted or unknown invocation is itself omitted (ADR-0009).
	const toolNamesByUseId = new Map<string, PublicToolName>();
	const appendWhileRunning = async (content: ModelContent): Promise<void> => {
		if (signal.aborted) throw new QueryInterruptedError();
		await appendModelContent(content);
		// The append itself is not abortable. Recheck after it settles so shutdown
		// cannot let the rest of the envelope append while the DB Run is still
		// fenced as running.
		if (signal.aborted) throw new QueryInterruptedError();
	};

	const commitEnvelope = async (commit: EnvelopeCommit): Promise<void> => {
		if (commit.text !== null) {
			await appendWhileRunning({
				kind: "assistant_message",
				payload: commit.text,
			});
		}
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
			await appendWhileRunning({
				kind: "tool_use",
				payload: projected.payload,
			});
			toolNamesByUseId.set(toolUse.id, tool);
		}
	};

	const appendToolResults = async (
		userMessage: Extract<SDKMessage, { type: "user" }>,
	): Promise<void> => {
		for (const block of toolResultBlocks(userMessage)) {
			const tool =
				block.toolUseId !== null
					? toolNamesByUseId.get(block.toolUseId)
					: undefined;
			if (block.toolUseId === null || tool === undefined) {
				params.logger?.warn({
					message: "tool result omitted: no appended invocation matches its id",
					runId: params.runId,
					toolUseId: block.toolUseId,
				});
				continue;
			}
			// One result per invocation: a second result for the same id is
			// unmatched, logged, and omitted.
			toolNamesByUseId.delete(block.toolUseId);
			const projected = projectToolResult(tool, block.content, block.isError);
			if (!projected.ok) {
				params.logger?.warn({
					message: "tool result omitted",
					runId: params.runId,
					tool,
					reason: projected.reason,
				});
				continue;
			}
			await appendWhileRunning({
				kind: "tool_result",
				payload: projected.payload,
			});
		}
	};

	// Best-effort: interrupt only needs to reach the SDK. Swallow its rejection so
	// a failed interrupt cannot become an unhandled rejection — the loop stops
	// appending on the same signal regardless.
	const interrupt = (): void => {
		void query.interrupt().catch(() => {});
	};
	if (signal.aborted) interrupt();
	else signal.addEventListener("abort", interrupt, { once: true });

	try {
		for await (const message of query) {
			// Track continuity signals before the abort skip: the pointer decision
			// reflects the whole stream, not just its pre-cancel prefix.
			if (isMirrorError(message)) outcome.mirrorErrorObserved = true;
			const sessionId = sessionIdFromResult(message);
			if (sessionId !== null) outcome.sessionId = sessionId;

			if (signal.aborted) continue;
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
				preview?.append(assembled.messageId, assembled.text);
			} else if (assembled?.type === "message_stop") {
				await preview?.flushMessage();
				await commitEnvelope(assembled.commit);
			}
		}
		if (signal.aborted) throw new QueryInterruptedError();
		assembler.finish();
		return outcome;
	} catch (error) {
		abandonOpenMessage();
		throw error;
	} finally {
		signal.removeEventListener("abort", interrupt);
		preview?.close();
	}
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
