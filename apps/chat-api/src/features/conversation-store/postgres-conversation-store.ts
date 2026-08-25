import type { Database } from "@mymemo/agent-db/client";
import {
	ACTIVE_RUN_STATUSES,
	conversations,
	runs,
} from "@mymemo/agent-db/schema";
import {
	and,
	desc,
	eq,
	getTableColumns,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import type {
	ConversationCreateInput,
	ConversationDeleteResult,
	ConversationListInput,
	ConversationListPage,
	ConversationRecord,
	ConversationRef,
	ConversationScope,
	ConversationStore,
	ConversationUpdate,
	ConversationUpdateResult,
} from "./conversation-store";

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

	async list(input: ConversationListInput): Promise<ConversationListPage> {
		const rows = await this.db
			.select({
				...getTableColumns(conversations),
				cursorLastActivityAt:
					sql<string>`to_char(${conversations.lastActivityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
						"cursor_last_activity_at",
					),
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, input.userId),
					input.archived
						? isNotNull(conversations.archivedAt)
						: isNull(conversations.archivedAt),
					input.search === undefined
						? undefined
						: sql`position(lower(${input.search}) in lower(${conversations.title})) > 0`,
					input.after === undefined
						? undefined
						: or(
								sql`${conversations.lastActivityAt} < ${input.after.lastActivityAt}::timestamptz`,
								and(
									sql`${conversations.lastActivityAt} = ${input.after.lastActivityAt}::timestamptz`,
									lt(conversations.conversationId, input.after.conversationId),
								),
							),
				),
			)
			.orderBy(
				desc(conversations.lastActivityAt),
				desc(conversations.conversationId),
			)
			.limit(input.limit + 1);

		const pageRows = rows.slice(0, input.limit);
		const last = pageRows.at(-1);
		return {
			conversations: pageRows.map(toConversationRecord),
			next:
				rows.length > input.limit && last
					? {
							lastActivityAt: last.cursorLastActivityAt,
							conversationId: last.conversationId,
						}
					: null,
		};
	}

	async update(
		ref: ConversationRef,
		changes: ConversationUpdate,
	): Promise<ConversationUpdateResult> {
		return await this.db.transaction(async (tx) => {
			const [conversation] = await tx
				.select({
					...getTableColumns(conversations),
					responseActive: sql<boolean>`${conversations.ownerUntil} > now()`,
				})
				.from(conversations)
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				)
				.for("update");
			if (!conversation) return { outcome: "not_found" };

			if (
				changes.archived !== undefined &&
				(conversation.responseActive || (await hasActiveRun(tx, ref)))
			) {
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
				.select({
					conversationId: conversations.conversationId,
					responseActive: sql<boolean>`${conversations.ownerUntil} > now()`,
				})
				.from(conversations)
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				)
				.for("update");
			if (!conversation) return { outcome: "not_found" };
			if (conversation.responseActive || (await hasActiveRun(tx, ref))) {
				return { outcome: "active_run" };
			}

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
