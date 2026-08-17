import type { ConversationExecutionRuntime } from "@mymemo/agent-db/execution-runtime";
import type { ChatMessagesScope } from "@/config/env";

/**
 * Durable conversation registry. A conversation record is the source of truth
 * for a conversation's immutable document scope and execution runtime — both
 * are created once and never changed, so a turn re-derives the same signed
 * scope every time instead of trusting per-request ids. It lives in chat-api's
 * writable `mymemo_agent` DB,
 * keyed by `{userId, conversationId}` like the sandbox lease, but is kept in a
 * separate table on purpose: the lease is a disposable optimization the reaper
 * may delete, whereas scope is a correctness/security boundary that must
 * outlive any sandbox.
 */

/**
 * The frozen document scope of a conversation. Aliases the canonical
 * {@link ChatMessagesScope} so the writable-DB layer and the turn path share one
 * definition instead of two identical unions.
 */
export type ConversationScope = ChatMessagesScope;

/** Identifies a conversation, scoped to its owner. */
export interface ConversationRef {
	userId: string;
	conversationId: string;
}

/** Input used to create a Conversation before database-owned lifecycle metadata
 * has been established. The execution runtime and Scope are frozen here;
 * `collectionId`/`summaryId` are non-null only for the matching Scope. */
export interface ConversationCreateInput {
	userId: string;
	conversationId: string;
	executionRuntime: ConversationExecutionRuntime;
	scope: ConversationScope;
	collectionId: string | null;
	summaryId: string | null;
}

/** A persisted Conversation with its full lifecycle metadata. */
export interface ConversationRecord extends ConversationCreateInput {
	title: string | null;
	createdAt: Date;
	lastActivityAt: Date;
	archivedAt: Date | null;
}

/** Mutable Conversation fields. Rename does not count as Conversation
 * activity; Archive is represented by a server-owned timestamp. */
export interface ConversationUpdate {
	title?: string;
	archived?: boolean;
}

/** Stable keyset position for Conversation activity ordering. */
export interface ConversationListPosition {
	/** Exact Postgres-rendered timestamp, retaining sub-millisecond precision. */
	lastActivityAt: string;
	conversationId: string;
}

export interface ConversationListInput {
	userId: string;
	archived: boolean;
	search?: string;
	after?: ConversationListPosition;
	limit: number;
}

export interface ConversationListPage {
	conversations: ConversationRecord[];
	next: ConversationListPosition | null;
}

export type ConversationUpdateResult =
	| { outcome: "updated"; conversation: ConversationRecord }
	| { outcome: "not_found" | "active_run" };

export type ConversationDeleteResult =
	| { outcome: "deleted" }
	| { outcome: "not_found" | "active_run" };

/**
 * Persistence seam for the conversation registry, keyed by `{userId,
 * conversationId}`. Scope is immutable after creation; lifecycle metadata is
 * changed only through the guarded update and admission paths. `create` is a
 * plain insert — a second create for the same key fails loudly rather than
 * silently re-scoping an existing conversation.
 */
export interface ConversationStore {
	get(ref: ConversationRef): Promise<ConversationRecord | null>;
	create(record: ConversationCreateInput): Promise<ConversationRecord>;
	list(input: ConversationListInput): Promise<ConversationListPage>;
	update(
		ref: ConversationRef,
		changes: ConversationUpdate,
	): Promise<ConversationUpdateResult>;
	deletePermanently(ref: ConversationRef): Promise<ConversationDeleteResult>;
}
