import type { Database } from "@mymemo/agent-db/client";
import {
	conversationMessages,
	conversationRuntime,
	conversations,
} from "@mymemo/agent-db/schema";
import type { UIMessage } from "ai";
import { and, eq, sql } from "drizzle-orm";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

export type ChatMessage = UIMessage<unknown, never, never>;

type UserMessageAdmission =
	| {
			outcome: "admitted";
			conversationEpoch: number;
			agentSessionId?: string;
	  }
	| { outcome: "not_found" | "archived" | "duplicate" };

export class PostgresChatMessageStore {
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
			const [runtime] = await tx
				.select({ agentSessionId: conversationRuntime.agentSessionId })
				.from(conversationRuntime)
				.where(
					and(
						eq(conversationRuntime.userId, ref.userId),
						eq(conversationRuntime.conversationId, ref.conversationId),
					),
				)
				.limit(1);
			return {
				outcome: "admitted",
				conversationEpoch: conversation.epoch,
				...(runtime?.agentSessionId
					? { agentSessionId: runtime.agentSessionId }
					: {}),
			};
		});
	}

	async persistAssistantMessageAndSession(
		ref: ConversationRef,
		message: ChatMessage,
		agentSessionId: string,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await tx.insert(conversationMessages).values({
				userId: ref.userId,
				conversationId: ref.conversationId,
				messageId: message.id,
				role: message.role,
				parts: message.parts,
			});
			await tx
				.insert(conversationRuntime)
				.values({
					userId: ref.userId,
					conversationId: ref.conversationId,
					agentSessionId,
				})
				.onConflictDoUpdate({
					target: [
						conversationRuntime.userId,
						conversationRuntime.conversationId,
					],
					set: { agentSessionId, updatedAt: sql`now()` },
				});
		});
	}
}
