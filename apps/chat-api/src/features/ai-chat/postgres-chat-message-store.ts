import type { Database } from "@mymemo/agent-db/client";
import { conversationMessages, conversations } from "@mymemo/agent-db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";
import type {
	ChatMessage,
	ChatMessageStore,
	UserMessageAdmission,
} from "./chat-message-store";

export class PostgresChatMessageStore implements ChatMessageStore {
	constructor(private readonly db: Database) {}

	async ownedConversationExists(ref: ConversationRef): Promise<boolean> {
		const rows = await this.db
			.select({ conversationId: conversations.conversationId })
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, ref.userId),
					eq(conversations.conversationId, ref.conversationId),
				),
			)
			.limit(1);
		return rows.length === 1;
	}

	async admitUserMessage(
		ref: ConversationRef,
		message: ChatMessage,
	): Promise<UserMessageAdmission> {
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
			if (conversation.archivedAt !== null) return { outcome: "archived" };

			const [duplicate] = await tx
				.select({ messageId: conversationMessages.messageId })
				.from(conversationMessages)
				.where(
					and(
						eq(conversationMessages.userId, ref.userId),
						eq(conversationMessages.conversationId, ref.conversationId),
						eq(conversationMessages.messageId, message.id),
					),
				)
				.limit(1);
			if (duplicate) return { outcome: "duplicate" };

			await tx.insert(conversationMessages).values({
				userId: ref.userId,
				conversationId: ref.conversationId,
				messageId: message.id,
				role: message.role,
				parts: message.parts,
			});
			const prompt = message.parts[0];
			if (!prompt || prompt.type !== "text") {
				throw new Error("direct User message must contain one text part");
			}
			await tx
				.update(conversations)
				.set({
					title: sql`coalesce(${conversations.title}, ${prompt.text})`,
					lastActivityAt: sql`now()`,
				})
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				);
			return {
				outcome: "admitted",
				conversationEpoch: conversation.epoch,
			};
		});
	}

	async persistAssistantMessage(
		ref: ConversationRef,
		message: ChatMessage,
	): Promise<void> {
		await this.db.insert(conversationMessages).values({
			userId: ref.userId,
			conversationId: ref.conversationId,
			messageId: message.id,
			role: message.role,
			parts: message.parts,
		});
	}

	async listMessages(ref: ConversationRef): Promise<ChatMessage[]> {
		const rows = await this.db
			.select()
			.from(conversationMessages)
			.where(
				and(
					eq(conversationMessages.userId, ref.userId),
					eq(conversationMessages.conversationId, ref.conversationId),
				),
			)
			.orderBy(asc(conversationMessages.sequence));
		return rows.map((row) => ({
			id: row.messageId,
			role: row.role as ChatMessage["role"],
			parts: row.parts as ChatMessage["parts"],
		}));
	}
}
