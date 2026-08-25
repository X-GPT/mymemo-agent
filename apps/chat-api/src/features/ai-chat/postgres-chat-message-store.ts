import type { Database } from "@mymemo/agent-db/client";
import { conversationOwnershipLeaseDeadline } from "@mymemo/agent-db/conversation-ownership";
import {
	clearConversationResponseAuthorityTx,
	lockLiveConversationResponseAuthorityTx,
	renewConversationResponseAuthorityTx,
} from "@mymemo/agent-db/response-authority";
import {
	conversationMessages,
	conversationRuntime,
	conversations,
} from "@mymemo/agent-db/schema";
import type { UIMessage } from "ai";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

export type ChatMessage = UIMessage<unknown, never, never>;

type UserMessageAdmission =
	| {
			outcome: "admitted";
			conversationEpoch: number;
			responseDeadline: Date;
			agentSessionId?: string;
	  }
	| { outcome: "not_found" | "archived" | "conflict" | "duplicate" };

type ChatHistoryResult =
	| { outcome: "found"; messages: ChatMessage[] }
	| { outcome: "not_found" };

type ActiveStreamResult =
	| {
			outcome: "found";
			activeStreamId: string | null;
			conversationEpoch: number;
	  }
	| { outcome: "not_found" };

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
				.select({
					...getTableColumns(conversations),
					executionAuthorityActive: sql<boolean>`${conversations.ownerUntil} > now()`,
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
			if (conversation.executionAuthorityActive) {
				return { outcome: "conflict" };
			}
			if (conversation.archivedAt !== null) {
				return { outcome: "archived" };
			}

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
				throw new Error("Agent-query User message must contain one text part");
			}
			const [updated] = await tx
				.update(conversations)
				.set({
					epoch: sql`${conversations.epoch} + 1`,
					ownerWorkerId: "agent-query",
					ownerUntil: conversationOwnershipLeaseDeadline(),
					activeStreamId: null,
					title: sql`coalesce(${conversations.title}, ${prompt.text})`,
					lastActivityAt: sql`now()`,
				})
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
					),
				)
				.returning({
					epoch: conversations.epoch,
					responseDeadline: conversations.ownerUntil,
				});
			if (!updated?.responseDeadline) {
				throw new Error("response admission returned no deadline");
			}
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
				conversationEpoch: updated.epoch,
				responseDeadline: updated.responseDeadline,
				...(runtime?.agentSessionId
					? { agentSessionId: runtime.agentSessionId }
					: {}),
			};
		});
	}

	async persistAssistantMessageAndSession(
		ref: ConversationRef,
		conversationEpoch: number,
		message: ChatMessage,
		agentSessionId: string,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await lockLiveConversationResponseAuthorityTx(tx, {
				...ref,
				epoch: conversationEpoch,
			});
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
			const [cleared] = await tx
				.update(conversations)
				.set({ ownerWorkerId: null, ownerUntil: null, activeStreamId: null })
				.where(
					and(
						eq(conversations.userId, ref.userId),
						eq(conversations.conversationId, ref.conversationId),
						eq(conversations.epoch, conversationEpoch),
					),
				)
				.returning({ conversationId: conversations.conversationId });
			if (!cleared)
				throw new Error("response authority changed during completion");
		});
	}

	async renewResponseAuthority(
		ref: ConversationRef,
		conversationEpoch: number,
	): Promise<Date | null> {
		return renewConversationResponseAuthorityTx(this.db, {
			...ref,
			epoch: conversationEpoch,
		});
	}

	async clearResponseAuthority(
		ref: ConversationRef,
		conversationEpoch: number,
	): Promise<boolean> {
		return clearConversationResponseAuthorityTx(this.db, {
			...ref,
			epoch: conversationEpoch,
		});
	}

	async setActiveStreamId(
		ref: ConversationRef,
		conversationEpoch: number,
		activeStreamId: string,
	): Promise<boolean> {
		const rows = await this.db
			.update(conversations)
			.set({ activeStreamId })
			.where(
				and(
					eq(conversations.userId, ref.userId),
					eq(conversations.conversationId, ref.conversationId),
					eq(conversations.epoch, conversationEpoch),
					sql`${conversations.ownerUntil} > now()`,
				),
			)
			.returning({ conversationId: conversations.conversationId });
		return rows.length > 0;
	}

	async clearActiveStreamId(
		ref: ConversationRef,
		conversationEpoch: number,
		activeStreamId: string,
	): Promise<boolean> {
		const rows = await this.db
			.update(conversations)
			.set({ activeStreamId: null })
			.where(
				and(
					eq(conversations.userId, ref.userId),
					eq(conversations.conversationId, ref.conversationId),
					eq(conversations.epoch, conversationEpoch),
					eq(conversations.activeStreamId, activeStreamId),
				),
			)
			.returning({ conversationId: conversations.conversationId });
		return rows.length > 0;
	}

	async listMessages(ref: ConversationRef): Promise<ChatHistoryResult> {
		if (!(await this.ownedConversationExists(ref))) {
			return { outcome: "not_found" };
		}
		const rows = await this.db
			.select({
				id: conversationMessages.messageId,
				role: conversationMessages.role,
				parts: conversationMessages.parts,
			})
			.from(conversationMessages)
			.where(
				and(
					eq(conversationMessages.userId, ref.userId),
					eq(conversationMessages.conversationId, ref.conversationId),
				),
			)
			.orderBy(conversationMessages.sequence);
		return { outcome: "found", messages: rows as ChatMessage[] };
	}

	async getActiveStream(ref: ConversationRef): Promise<ActiveStreamResult> {
		const [row] = await this.db
			.select({
				activeStreamId: conversations.activeStreamId,
				conversationEpoch: conversations.epoch,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, ref.userId),
					eq(conversations.conversationId, ref.conversationId),
				),
			);
		return row ? { outcome: "found", ...row } : { outcome: "not_found" };
	}
}
