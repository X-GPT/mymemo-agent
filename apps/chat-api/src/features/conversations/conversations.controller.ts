import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationScope,
	ConversationStore,
} from "@/features/conversation-store";
import type { RunCancellationResult } from "@/features/run-store";
import {
	type InternalIdentity,
	type RunAgentInputBody,
	submittedMessageFromRunInput,
} from "./conversations.schema";

/**
 * Create a conversation: resolve its document scope from the supplied ids once,
 * freeze it onto a new record, and return the generated id + scope. The scope is
 * never re-derived after this — every turn reads it back from the store.
 */
export async function createConversation(
	store: ConversationStore,
	identity: InternalIdentity,
	body: { collectionId?: string | null; summaryId?: string | null },
): Promise<{ conversationId: string; scope: ConversationScope }> {
	const conversationId = crypto.randomUUID();
	const collectionId = body.collectionId?.trim() || null;
	const summaryId = body.summaryId?.trim() || null;

	let scope: ConversationScope = "general";
	if (summaryId) {
		scope = "document";
	} else if (collectionId) {
		scope = "collection";
	}

	await store.create({
		userId: identity.memberCode,
		conversationId,
		scope,
		collectionId,
		summaryId,
	});
	return { conversationId, scope };
}

/**
 * Queue one `user.message` turn against an existing conversation. Scope comes
 * from the frozen `conversation` record (not the request), so the client cannot
 * widen it. The queued run and its `run_started` event are written before the
 * SSE stream opens; the stream then projects the durable `run_events` log and
 * may merge the prepared, cursorless Live preview subscription.
 */
export async function queueConversationTurn(
	deps: AppDeps,
	params: { conversation: ConversationRecord; message: string; runId?: string },
): Promise<{ runId: string }> {
	return deps.runStore.createQueuedRun({
		conversation: params.conversation,
		message: params.message,
		runId: params.runId,
	});
}

/** Atomically admit one strict AG-UI Run using only the final submitted User
 * message plus the server-owned frozen Conversation data. Client history is
 * validation input, not new durable history. */
export async function admitAgUiRun(
	deps: AppDeps,
	params: { conversation: ConversationRecord; input: RunAgentInputBody },
) {
	const submitted = submittedMessageFromRunInput(params.input);
	return deps.runStore.admitRun({
		conversation: params.conversation,
		runId: params.input.runId,
		messageId: submitted.messageId,
		message: submitted.message,
	});
}

/**
 * Request cancellation of an existing run (`user.interrupt`). The lookup is
 * scoped by the already-ownership-checked `conversation` record, so a run
 * belonging to another member or conversation is `not_found`, never a state
 * change. Control events never create runs and never open SSE.
 */
export async function interruptConversationRun(
	deps: AppDeps,
	params: { conversation: ConversationRecord; runId: string },
): Promise<RunCancellationResult> {
	return deps.runStore.requestCancellation({
		userId: params.conversation.userId,
		conversationId: params.conversation.conversationId,
		runId: params.runId,
	});
}
