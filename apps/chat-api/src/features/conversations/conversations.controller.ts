import type { AppDeps } from "@/deps";
import type {
	ConversationRecord,
	ConversationScope,
	ConversationStore,
} from "@/features/conversation-store/conversation-store";
import {
	type InternalIdentity,
	type RunAgentInputBody,
	submittedMessageFromRunInput,
} from "./conversations.schema";

/** Public Conversation metadata shared by creation, list, and lifecycle routes. */
export interface ConversationSummary {
	conversationId: string;
	title: string | null;
	scope: ConversationScope;
	createdAt: string;
	lastActivityAt: string;
	archivedAt: string | null;
}

export function toConversationSummary(
	conversation: ConversationRecord,
): ConversationSummary {
	return {
		conversationId: conversation.conversationId,
		title: conversation.title,
		scope: conversation.scope,
		createdAt: conversation.createdAt.toISOString(),
		lastActivityAt: conversation.lastActivityAt.toISOString(),
		archivedAt: conversation.archivedAt?.toISOString() ?? null,
	};
}

/**
 * Create a conversation: resolve its document scope from the supplied ids once,
 * freeze it onto a new record, and return its public summary. The scope is never
 * re-derived after this — every turn reads it back from the store.
 */
export async function createConversation(
	store: ConversationStore,
	identity: InternalIdentity,
	body: { collectionId?: string | null; summaryId?: string | null },
): Promise<ConversationSummary> {
	const conversationId = crypto.randomUUID();
	const collectionId = body.collectionId?.trim() || null;
	const summaryId = body.summaryId?.trim() || null;

	let scope: ConversationScope = "general";
	if (summaryId) {
		scope = "document";
	} else if (collectionId) {
		scope = "collection";
	}

	const conversation = await store.create({
		userId: identity.memberCode,
		conversationId,
		scope,
		collectionId,
		summaryId,
	});
	return toConversationSummary(conversation);
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
