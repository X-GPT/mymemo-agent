import type { ChatMessagesScope } from "@/config/env";
import { runSandboxChat } from "@/features/sandbox-orchestration";
import type { EventMessage } from "./chat.events";
import type { ChatLogger } from "./chat.logger";
import type { ChatRequest } from "./chat.schema";
import type { MymemoEventSender } from "./chat.streaming";

export async function complete(
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

	const sendEvent = (message: EventMessage): Promise<void> =>
		mymemoEventSender.send({ id: crypto.randomUUID(), message });

	// Announce run identity up front so clients can persist the thread id and
	// correlate the run before any text streams.
	await sendEvent({
		type: "conversation_id",
		conversationId: resolvedConversationId,
	});
	await sendEvent({ type: "run_id", runId });

	const onTextDelta = async (text: string) => {
		try {
			await sendEvent({ type: "text_delta", text });
		} catch (err) {
			logger.error({ message: "Failed to send text_delta", error: err });
		}
	};

	const onTextEnd = async () => {
		await sendEvent({ type: "done" });
	};

	const onAgentSessionId = async (agentSessionId: string) => {
		try {
			await sendEvent({ type: "agent_session_id", agentSessionId });
		} catch (err) {
			logger.error({
				message: "Failed to send agent_session_id event",
				error: err,
			});
		}
	};

	const onSandboxId = async (newSandboxId: string) => {
		try {
			await sendEvent({ type: "sandbox_id", sandboxId: newSandboxId });
		} catch (err) {
			logger.error({ message: "Failed to send sandbox_id event", error: err });
		}
	};

	await runSandboxChat({
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
		onTextDelta,
		onTextEnd,
		onAgentSessionId,
		onSandboxId,
		logger,
	});
}
