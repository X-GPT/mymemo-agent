import { and, eq } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import {
	conversationExecutionAuthorityDeadline,
	liveConversationExecutionAuthorityState,
} from "./conversation-ownership";
import { conversations } from "./schema";

/** Direct-response authority reuses the Conversation epoch/deadline without a Run. */
export type ConversationResponseAuthority = {
	conversationId: string;
	epoch: number;
	userId?: string;
};

function responseAuthorityConditions(authority: ConversationResponseAuthority) {
	return and(
		authority.userId === undefined
			? undefined
			: eq(conversations.userId, authority.userId),
		eq(conversations.conversationId, authority.conversationId),
		eq(conversations.epoch, authority.epoch),
	);
}

function liveResponseAuthorityConditions(
	authority: ConversationResponseAuthority,
) {
	return and(
		responseAuthorityConditions(authority),
		liveConversationExecutionAuthorityState(),
	);
}

export async function verifyConversationResponseAuthorityTx(
	db: Database,
	authority: ConversationResponseAuthority,
): Promise<Date | null> {
	const [row] = await db
		.select({ deadline: conversations.ownerUntil })
		.from(conversations)
		.where(liveResponseAuthorityConditions(authority));
	return row?.deadline ?? null;
}

export async function renewConversationResponseAuthorityTx(
	db: Database,
	authority: ConversationResponseAuthority,
): Promise<Date | null> {
	const [row] = await db
		.update(conversations)
		.set({ ownerUntil: conversationExecutionAuthorityDeadline() })
		.where(liveResponseAuthorityConditions(authority))
		.returning({ deadline: conversations.ownerUntil });
	return row?.deadline ?? null;
}

export async function lockLiveConversationResponseAuthorityTx(
	tx: DbTx,
	authority: ConversationResponseAuthority,
): Promise<Date> {
	const [row] = await tx
		.select({ deadline: conversations.ownerUntil })
		.from(conversations)
		.where(liveResponseAuthorityConditions(authority))
		.for("share");
	if (!row?.deadline) {
		throw new Error(
			`response authority for conversation ${authority.conversationId} is stale or expired`,
		);
	}
	return row.deadline;
}

export async function clearConversationResponseAuthorityTx(
	db: Database,
	authority: ConversationResponseAuthority,
): Promise<boolean> {
	const rows = await db
		.update(conversations)
		.set({ ownerWorkerId: null, ownerUntil: null, activeStreamId: null })
		.where(responseAuthorityConditions(authority))
		.returning({ conversationId: conversations.conversationId });
	return rows.length > 0;
}
