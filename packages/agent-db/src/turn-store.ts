import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client";
import {
	type ALL_TURN_STATUSES,
	conversationMessages,
	conversations,
	type TERMINAL_TURN_STATUSES,
} from "./schema";

/**
 * Race-safe Turn-queue primitives over `conversation_messages` (ADR-0034,
 * spec #654, ticket #656). The user-message row is the Turn record; the
 * database itself gates one-in-flight per Conversation and makes
 * terminalization at-most-once: every status transition here is guarded by the
 * status it moves from, so a Turn that reached the Outcome triad can never
 * transition again. chat-api only enqueues and reads; the In-VM server drives
 * claim, terminalize, boot sweep, and queued-cancel.
 */

export type TurnStatus = (typeof ALL_TURN_STATUSES)[number];
export type TurnOutcome = (typeof TERMINAL_TURN_STATUSES)[number];

/**
 * A user-role row narrowed to the Turn lifecycle: the turn-status check
 * constrains user rows to a legal Turn status, so the narrowing holds by
 * database invariant.
 */
export type TurnRecord = Omit<
	typeof conversationMessages.$inferSelect,
	"status"
> & { status: TurnStatus };

function turnKey(input: {
	userId: string;
	conversationId: string;
	messageId: string;
}) {
	return and(
		eq(conversationMessages.userId, input.userId),
		eq(conversationMessages.conversationId, input.conversationId),
		eq(conversationMessages.messageId, input.messageId),
	);
}

function conversationTurns(input: { userId: string; conversationId: string }) {
	return and(
		eq(conversationMessages.userId, input.userId),
		eq(conversationMessages.conversationId, input.conversationId),
		eq(conversationMessages.role, "user"),
	);
}

/**
 * Admit a user message as a `queued` Turn. Returns false for a re-insert of
 * the same client message id — the table's primary key is the idempotency
 * authority, and the duplicate leaves the existing row (parts and Turn status
 * alike) untouched.
 */
export async function enqueueTurnTx(
	db: Database,
	input: {
		userId: string;
		conversationId: string;
		messageId: string;
		parts: unknown;
	},
): Promise<boolean> {
	const inserted = await db
		.insert(conversationMessages)
		.values({ ...input, role: "user", status: "queued" })
		.onConflictDoNothing()
		.returning({ sequence: conversationMessages.sequence });
	return inserted.length > 0;
}

/**
 * Atomically move the Conversation's next Turn (lowest sequence `queued`) to
 * `processing`, only when nothing is `processing` — the one-in-flight gate the
 * spec puts in the database. Claimers serialize on the Conversation row lock
 * (the repo's global Conversation-first lock order), so concurrent claimers
 * get at most one winner; the queued-status guard on the update means a
 * concurrent queued-cancel costs this claim its Turn rather than resurrecting
 * a cancelled one. Returns the claimed Turn, or null when there is nothing to
 * claim, a Turn is already in flight, or the Conversation does not exist.
 */
export async function claimNextTurnTx(
	db: Database,
	input: { userId: string; conversationId: string },
): Promise<TurnRecord | null> {
	return await db.transaction(async (tx) => {
		const [conversation] = await tx
			.select({ conversationId: conversations.conversationId })
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, input.userId),
					eq(conversations.conversationId, input.conversationId),
				),
			)
			.for("update");
		if (!conversation) return null;

		const [processing] = await tx
			.select({ messageId: conversationMessages.messageId })
			.from(conversationMessages)
			.where(
				and(
					conversationTurns(input),
					eq(conversationMessages.status, "processing"),
				),
			)
			.limit(1);
		if (processing) return null;

		const [next] = await tx
			.select()
			.from(conversationMessages)
			.where(
				and(
					conversationTurns(input),
					eq(conversationMessages.status, "queued"),
				),
			)
			.orderBy(asc(conversationMessages.sequence))
			.limit(1);
		if (!next) return null;

		const [claimed] = await tx
			.update(conversationMessages)
			.set({ status: "processing", startedAt: new Date() })
			.where(and(turnKey(next), eq(conversationMessages.status, "queued")))
			.returning();
		return claimed
			? { ...claimed, status: claimed.status as TurnStatus }
			: null;
	});
}

/**
 * Move one `processing` Turn to its Outcome. The from-status guard is the
 * at-most-once authority: a Turn already at an Outcome (or still queued)
 * matches nothing and the call reports false, so no Outcome is ever
 * overwritten.
 */
export async function terminalizeTurnTx(
	db: Database,
	input: {
		userId: string;
		conversationId: string;
		messageId: string;
		outcome: TurnOutcome;
	},
): Promise<boolean> {
	const terminalized = await db
		.update(conversationMessages)
		.set({ status: input.outcome, finishedAt: new Date() })
		.where(and(turnKey(input), eq(conversationMessages.status, "processing")))
		.returning({ messageId: conversationMessages.messageId });
	return terminalized.length > 0;
}

/**
 * Boot sweep: terminalize the Conversation's stale `processing` Turns as
 * `interrupted` — a Turn is never re-run. `queued` Turns are untouched, and a
 * repeat sweep finds nothing (the interrupted Turns are terminal). Returns the
 * swept message ids.
 */
export async function sweepStaleProcessingTurnsTx(
	db: Database,
	input: { userId: string; conversationId: string },
): Promise<string[]> {
	const swept = await db
		.update(conversationMessages)
		.set({ status: "interrupted", finishedAt: new Date() })
		.where(
			and(
				conversationTurns(input),
				eq(conversationMessages.status, "processing"),
			),
		)
		.returning({ messageId: conversationMessages.messageId });
	return swept.map(({ messageId }) => messageId);
}

/**
 * Cancel a `queued` Turn directly to `interrupted` without it ever running —
 * `started_at` stays NULL. A Turn already claimed (or already terminal)
 * matches nothing and the call reports false.
 */
export async function cancelQueuedTurnTx(
	db: Database,
	input: { userId: string; conversationId: string; messageId: string },
): Promise<boolean> {
	const cancelled = await db
		.update(conversationMessages)
		.set({ status: "interrupted", finishedAt: new Date() })
		.where(and(turnKey(input), eq(conversationMessages.status, "queued")))
		.returning({ messageId: conversationMessages.messageId });
	return cancelled.length > 0;
}
