import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { conversations, runs } from "@/db/schema";
import type {
	ConversationCreateInput,
	ConversationDeleteResult,
	ConversationRecord,
	ConversationRef,
	ConversationScope,
	ConversationStore,
	ConversationUpdate,
	ConversationUpdateResult,
} from "./conversation-store";

const ACTIVE_RUN_STATUSES = ["queued", "running", "cancel_requested"] as const;

type ConversationRow = typeof conversations.$inferSelect;
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function toConversationRecord(row: ConversationRow): ConversationRecord {
	return { ...row, scope: row.scope as ConversationScope };
}

/**
 * Drizzle adapter for {@link ConversationStore}, over the `conversations` table.
 * The composite primary key `(user_id, conversation_id)` scopes every row to its
 * owner and makes a duplicate create for the same conversation impossible.
 */
export class PostgresConversationStore implements ConversationStore {
	constructor(private readonly db: Database) {}

	async get(ref: ConversationRef): Promise<ConversationRecord | null> {
		const rows = await this.db
			.select()
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
		return toConversationRecord(row);
	}

	async create(record: ConversationCreateInput): Promise<ConversationRecord> {
		// Plain insert: the composite PK makes a second create for the same
		// conversation throw rather than silently re-scope it.
		const [created] = await this.db
			.insert(conversations)
			.values({
				userId: record.userId,
				conversationId: record.conversationId,
				scope: record.scope,
				collectionId: record.collectionId,
				summaryId: record.summaryId,
			})
			.returning();
		if (!created) {
			throw new Error(
				`insert of conversation ${record.conversationId} returned no row`,
			);
		}
		return toConversationRecord(created);
	}

	async update(
		ref: ConversationRef,
		changes: ConversationUpdate,
	): Promise<ConversationUpdateResult> {
		return await this.db.transaction(async (tx) => {
			const [conversation] = await tx
				.select()
				.from(conversations)
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				)
				.for("update");
			if (!conversation) return { outcome: "not_found" };

			if (changes.archived !== undefined && (await hasActiveRun(tx, ref))) {
				return { outcome: "active_run" };
			}

			const [updated] = await tx
				.update(conversations)
				.set({
					title: changes.title,
					archivedAt:
						changes.archived === undefined
							? undefined
							: changes.archived
								? sql`coalesce(${conversations.archivedAt}, now())`
								: null,
				})
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				)
				.returning();
			if (!updated) {
				throw new Error(
					`locked conversation ${ref.conversationId} vanished during update`,
				);
			}
			return {
				outcome: "updated",
				conversation: toConversationRecord(updated),
			};
		});
	}

	async deletePermanently(
		ref: ConversationRef,
	): Promise<ConversationDeleteResult> {
		return await this.db.transaction(async (tx) => {
			const [conversation] = await tx
				.select({ conversationId: conversations.conversationId })
				.from(conversations)
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				)
				.for("update");
			if (!conversation) return { outcome: "not_found" };
			if (await hasActiveRun(tx, ref)) return { outcome: "active_run" };

			await tx
				.delete(conversations)
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				);
			return { outcome: "deleted" };
		});
	}
}

async function hasActiveRun(
	db: DbTransaction,
	ref: ConversationRef,
): Promise<boolean> {
	const rows = await db
		.select({ runId: runs.runId })
		.from(runs)
		.where(
			and(
				eq(runs.userId, ref.userId),
				eq(runs.conversationId, ref.conversationId),
				inArray(runs.status, ACTIVE_RUN_STATUSES),
			),
		)
		.limit(1);
	return rows.length > 0;
}
