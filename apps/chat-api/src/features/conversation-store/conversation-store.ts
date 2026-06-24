/**
 * Durable conversation registry. A conversation record is the source of truth
 * for a conversation's immutable document scope — created once and never
 * re-scoped, so a turn re-derives the same signed scope every time instead of
 * trusting per-request ids. It lives in chat-api's writable `mymemo_agent` DB,
 * keyed by `{userId, conversationId}` like the sandbox lease, but is kept in a
 * separate table on purpose: the lease is a disposable optimization the reaper
 * may delete, whereas scope is a correctness/security boundary that must
 * outlive any sandbox.
 */

/** The frozen document scope of a conversation. */
export type ConversationScope = "general" | "collection" | "document";

/** Identifies a conversation, scoped to its owner. */
export interface ConversationRef {
	userId: string;
	conversationId: string;
}

/** A persisted conversation. `collectionId`/`summaryId` are non-null only for
 * the matching scope. */
export interface ConversationRecord {
	userId: string;
	conversationId: string;
	scope: ConversationScope;
	collectionId: string | null;
	summaryId: string | null;
}

/**
 * Persistence seam for the conversation registry, keyed by `{userId,
 * conversationId}`. Small on purpose: a conversation is created once and read
 * each turn. `create` is a plain insert — a second create for the same key fails
 * loudly rather than silently re-scoping an existing conversation.
 */
export interface ConversationStore {
	get(ref: ConversationRef): Promise<ConversationRecord | null>;
	create(record: ConversationRecord): Promise<void>;
}
