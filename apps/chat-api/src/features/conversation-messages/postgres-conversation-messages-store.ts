import type { Database, DbTx } from "@mymemo/agent-db/client";
import { conversationMessages, conversations } from "@mymemo/agent-db/schema";
import { enqueueTurnTx, type TurnStatus } from "@mymemo/agent-db/turn-store";
import { and, desc, eq, lt } from "drizzle-orm";
import type {
	ConversationMessagesPage,
	ConversationMessagesPageInput,
	ConversationMessagesStore,
	ConversationUiMessage,
	EnqueueTurnResult,
	TurnRef,
	TurnSubmissionStore,
} from "./conversation-messages-store";

export class PostgresConversationMessagesStore
	implements ConversationMessagesStore, TurnSubmissionStore
{
	constructor(private readonly db: Database) {}

	async getPage(
		input: ConversationMessagesPageInput,
	): Promise<ConversationMessagesPage | null> {
		if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
			throw new Error("Messages page limit must be a positive integer");
		}
		const [conversation] = await this.db
			.select({ conversationId: conversations.conversationId })
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, input.userId),
					eq(conversations.conversationId, input.conversationId),
				),
			);
		if (!conversation) return null;

		// Newest-first keyset page on the (user, conversation, sequence) index,
		// one row past the limit to learn whether an older page exists; served
		// ascending. `sequence` makes the cursor stable: later appends only ever
		// take higher values.
		const rows = await this.db
			.select()
			.from(conversationMessages)
			.where(
				and(
					eq(conversationMessages.userId, input.userId),
					eq(conversationMessages.conversationId, input.conversationId),
					input.before === null
						? undefined
						: lt(conversationMessages.sequence, input.before),
				),
			)
			.orderBy(desc(conversationMessages.sequence))
			.limit(input.limit + 1);

		const hasOlder = rows.length > input.limit;
		const page = rows.slice(0, input.limit).reverse();
		return {
			messages: page.map(toUiMessage),
			nextCursor: hasOlder ? (page[0]?.sequence ?? null) : null,
		};
	}

	async enqueueTurn(
		input: TurnRef & { parts: unknown },
	): Promise<EnqueueTurnResult> {
		return await this.db.transaction(async (tx) => {
			const [conversation] = await tx
				.select({ archivedAt: conversations.archivedAt })
				.from(conversations)
				.where(
					and(
						eq(conversations.userId, input.userId),
						eq(conversations.conversationId, input.conversationId),
					),
				)
				.for("update");
			if (!conversation) return { outcome: "not_found" };
			if (conversation.archivedAt !== null) return { outcome: "archived" };
			if (await enqueueTurnTx(tx, input)) return { outcome: "queued" };
			const status = await selectTurnStatus(tx, input);
			if (status === null) {
				throw new Error(`duplicate message ${input.messageId} is not a Turn`);
			}
			return { outcome: "duplicate", status };
		});
	}

	getTurnStatus(ref: TurnRef): Promise<TurnStatus | null> {
		return selectTurnStatus(this.db, ref);
	}
}

async function selectTurnStatus(
	db: Database | DbTx,
	ref: TurnRef,
): Promise<TurnStatus | null> {
	const [row] = await db
		.select({ status: conversationMessages.status })
		.from(conversationMessages)
		.where(
			and(
				eq(conversationMessages.userId, ref.userId),
				eq(conversationMessages.conversationId, ref.conversationId),
				eq(conversationMessages.messageId, ref.messageId),
				eq(conversationMessages.role, "user"),
			),
		);
	// The turn-status check makes a user row's status a non-null TurnStatus.
	return row ? (row.status as TurnStatus) : null;
}

function toUiMessage(
	row: typeof conversationMessages.$inferSelect,
): ConversationUiMessage {
	const message = {
		id: row.messageId,
		// The role check constrains rows to these two values at the database.
		role: row.role as "user" | "assistant",
		parts: row.parts,
	};
	if (row.role !== "user") return message;
	return {
		...message,
		metadata: {
			// The turn-status check makes a user row's status a non-null
			// TurnStatus by database invariant.
			status: row.status as TurnStatus,
			startedAt: row.startedAt,
			finishedAt: row.finishedAt,
		},
	};
}
