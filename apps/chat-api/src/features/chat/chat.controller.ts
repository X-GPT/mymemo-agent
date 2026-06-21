import type { ChatMessagesScope } from "@/config/env";
import type { AppDeps } from "@/deps";
import { createRun } from "@/features/run-state";
import {
	ConversationBusyError,
	runSandboxChat,
} from "@/features/sandbox-orchestration";
import type { ChatLogger } from "./chat.logger";
import type { ChatRequest } from "./chat.schema";
import type { MymemoEventSender } from "./chat.streaming";
import { createSseRunEventSink } from "./run-event-sink";

export async function complete(
	deps: AppDeps,
	request: ChatRequest,
	mymemoEventSender: MymemoEventSender,
	logger: ChatLogger,
) {
	const { chatContent, collectionId, summaryId, conversationId, memberCode } =
		request;

	// Generated at request entry. `runId` identifies this single backend
	// execution attempt; `resolvedConversationId` is the product-visible thread
	// id, generated here when the client does not supply one.
	const runId = crypto.randomUUID();
	const resolvedConversationId = conversationId ?? crypto.randomUUID();

	const normalizedCollectionId = collectionId?.trim() ?? null;
	const normalizedSummaryId = summaryId?.trim() ?? null;

	let scope: ChatMessagesScope = "general";
	if (normalizedSummaryId) {
		scope = "document";
	} else if (normalizedCollectionId) {
		scope = "collection";
	}

	// The client-visible stream is a projection of the run's recorded events:
	// each event is persisted durably, then mapped to its SSE frame(s). Wiring
	// the run lifecycle through this sink means a frame is only ever sent for an
	// event that was recorded.
	const run = await createRun({
		sink: createSseRunEventSink(deps.workspaceStore, mymemoEventSender, logger),
		ref: { userId: memberCode, runId },
		conversationId: resolvedConversationId,
	});
	// `createRun` recorded `run_started`, from which the client's first frames —
	// `conversation_id` and `run_id` — were derived.

	try {
		await runSandboxChat(deps, {
			userId: memberCode,
			conversationId: resolvedConversationId,
			runId,
			query: chatContent,
			scope,
			collectionId: normalizedCollectionId,
			summaryId: normalizedSummaryId,
			// The client no longer supplies Claude SDK resume state; conversation
			// continuity via `conversationId` is wired in a later milestone.
			agentSessionId: null,
			// Daemon stream events become run events; their SSE frames are derived
			// from the recorded events, not sent ad hoc.
			onSandboxId: (sandboxId) => run.recordSandboxLeased(sandboxId),
			onAgentSessionId: (agentSessionId) =>
				run.recordAgentEvent({ type: "session_id", sessionId: agentSessionId }),
			onTextDelta: (text) => run.recordAgentEvent({ type: "text_delta", text }),
			logger,
		});
		// `done` is derived from `run_completed`, emitted only after the whole run
		// (including workspace sync) succeeds — not at end of the text stream.
		await run.markRunCompleted();
	} catch (err) {
		// Any daemon, transport, or orchestration failure terminates the run and
		// derives the client's `error` frame. Log the original error (stack, cause,
		// type) here — the durable run log only records a normalized message.
		if (err instanceof ConversationBusyError) {
			// Expected, retryable backpressure — not a failure to alert on. The
			// client gets a friendlier, actionable message.
			logger.warn({ message: "Sandbox chat run rejected: conversation busy" });
			await run.markRunFailed(
				new Error(
					"Sandbox is busy processing another request. Please try again shortly.",
				),
			);
		} else {
			logger.error({ message: "Sandbox chat run failed", error: err });
			await run.markRunFailed(err);
		}
	}
}
