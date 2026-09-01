import type { TurnStatus } from "@mymemo/agent-db/turn-store";

/**
 * The /v2 Conversation history read contract (spec #654, ticket #663): the
 * durable UIMessages of one Conversation in ascending `sequence` order.
 * chat-api only reads this projection — the In-VM server is the sole writer —
 * so a page shows exactly what durably committed: an interrupted or error Turn
 * carries its completed Steps and never provisional text, by the writer's
 * commit-before-publish invariant, not by any filtering here.
 */

/**
 * Turn lifecycle riding a user message as UIMessage metadata. Column names
 * (`status`/`started_at`/`finished_at`) surface in the API's camelCase, like
 * every other route.
 */
export interface TurnMetadata {
	status: TurnStatus;
	startedAt: Date | null;
	finishedAt: Date | null;
}

export interface ConversationUiMessage {
	id: string;
	role: "user" | "assistant";
	/** Stored UIMessage parts, returned verbatim (step and tool parts included). */
	parts: unknown;
	/** Present exactly on user messages — a user row IS the Turn record. */
	metadata?: TurnMetadata;
}

export interface ConversationMessagesPage {
	/** One page in ascending `sequence`; the newest page when `before` is null. */
	messages: ConversationUiMessage[];
	/** `?before` value for the next older page, or null at the beginning. */
	nextCursor: number | null;
}

export interface ConversationMessagesPageInput {
	userId: string;
	conversationId: string;
	limit: number;
	/** Exclusive upper `sequence` bound; null asks for the newest page. */
	before: number | null;
}

export interface ConversationMessagesStore {
	/**
	 * Null when the owner has no such Conversation (missing and foreign look
	 * identical); an empty page — not null — when the Conversation exists with
	 * no v2 rows, which is every pre-v2 Conversation. Archived Conversations
	 * read normally.
	 */
	getPage(
		input: ConversationMessagesPageInput,
	): Promise<ConversationMessagesPage | null>;
}
