import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { conversations } from "@/db/schema";
import type {
	ConversationRecord,
	ConversationRef,
	ConversationScope,
	ConversationStore,
} from "./conversation-store";

/**
 * Drizzle adapter for {@link ConversationStore}, over the `conversations` table.
 * The composite primary key `(user_id, conversation_id)` scopes every row to its
 * owner and makes a duplicate create for the same conversation impossible.
 */
export class PostgresConversationStore implements ConversationStore {
	constructor(private readonly db: Database) {}

	async get(ref: ConversationRef): Promise<ConversationRecord | null> {
		const rows = await this.db
			.select({
				userId: conversations.userId,
				conversationId: conversations.conversationId,
				scope: conversations.scope,
				collectionId: conversations.collectionId,
				summaryId: conversations.summaryId,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, ref.userId),
					eq(conversations.conversationId, ref.conversationId),
				),
			)
			.limit(1);
		const row = rows[0];
		if (!row) return null;
		// `scope` is stored as text; it is only ever written through `create` from
		// the typed union, so narrowing here is safe.
		return { ...row, scope: row.scope as ConversationScope };
	}

	async create(record: ConversationRecord): Promise<void> {
		// Plain insert: the composite PK makes a second create for the same
		// conversation throw rather than silently re-scope it.
		await this.db.insert(conversations).values({
			userId: record.userId,
			conversationId: record.conversationId,
			scope: record.scope,
			collectionId: record.collectionId,
			summaryId: record.summaryId,
		});
	}
}
