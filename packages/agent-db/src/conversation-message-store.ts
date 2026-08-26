import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { conversationMessages, conversations } from "./schema";

export type AdmitConversationMessageResult = {
	outcome: "admitted" | "not_found" | "archived" | "conflict";
};

export async function admitConversationMessageTx(
	db: Database,
	input: {
		userId: string;
		conversationId: string;
		messageId: string;
		parts: [{ type: "text"; text: string }];
	},
): Promise<AdmitConversationMessageResult> {
	return await db.transaction(async (tx) => {
		const [conversation] = await tx
			.select()
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

		const [inserted] = await tx
			.insert(conversationMessages)
			.values({
				userId: input.userId,
				conversationId: input.conversationId,
				messageId: input.messageId,
				role: "user",
				parts: input.parts,
			})
			.onConflictDoNothing()
			.returning({ messageId: conversationMessages.messageId });
		if (!inserted) return { outcome: "conflict" };
		await tx
			.update(conversations)
			.set({
				title: sql`coalesce(${conversations.title}, ${input.parts[0].text})`,
				lastActivityAt: sql`now()`,
			})
			.where(
				and(
					eq(conversations.userId, input.userId),
					eq(conversations.conversationId, input.conversationId),
				),
			);
		return { outcome: "admitted" };
	});
}

export async function appendAssistantMessageTx(
	db: Database,
	input: {
		userId: string;
		conversationId: string;
		messageId: string;
		parts: unknown;
	},
): Promise<void> {
	await db.insert(conversationMessages).values({
		...input,
		role: "assistant",
	});
}
