import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import { conversations } from "./schema";

/** Conversation Ownership renewal, release, and mutation fences. AgentCore's
 * exact-dispatch transaction establishes Ownership; no queue Claim lives here.
 * No Run-scoped lease or competing ownership predicate exists. */

/**
 * How far ahead acquisition or renewal pushes `owner_until`: a 60s hold renewed
 * on the Runtime's 15s heartbeat, allowing four missed renewals before the
 * Conversation becomes reclaimable.
 */
export const CONVERSATION_OWNERSHIP_LEASE_MS = 60_000;

/** The shared database-time expression for Ownership mutations and their Run writes. */
export function conversationOwnershipClock(now?: Date) {
	return now ? sql`${now}::timestamptz` : sql`now()`;
}

/** Exact acquisition or renewal pushes the same database deadline. */
export function conversationOwnershipLeaseDeadline(now?: Date) {
	return sql`${conversationOwnershipClock(now)} + (${CONVERSATION_OWNERSHIP_LEASE_MS} * interval '1 millisecond')`;
}

/** The one database-clock predicate defining whether Ownership is live. */
export function liveConversationOwnershipState(now?: Date) {
	return sql<boolean>`${conversations.ownerWorkerId} is not null
		and ${conversations.ownerUntil} > ${conversationOwnershipClock(now)}`;
}

/**
 * One acquisition of a Conversation and its Ownership epoch. This is the whole
 * authority a fenced write needs — the
 * owning worker's id is provenance and deliberately absent.
 */
export interface ConversationOwner {
	userId: string;
	conversationId: string;
	epoch: number;
}

/** A Conversation's live Ownership fence rejected a worker mutation. */
export class ConversationOwnershipFenceError extends Error {
	override name = "ConversationOwnershipFenceError" as const;
}

/**
 * Release Ownership unconditionally on `(conversation, epoch)`. A superseded
 * holder matches zero rows and cannot take the Conversation back from its
 * successor. Returns whether this acquisition was still current.
 *
 * A worker that has *lost* its lease must not call this at all — it must halt
 * and abandon. The epoch match makes that safe rather than merely advisable.
 */
export async function releaseConversationTx(
	db: Database,
	owner: ConversationOwner,
): Promise<boolean> {
	const released = await db
		.update(conversations)
		.set({ ownerWorkerId: null, ownerUntil: null })
		.where(ownedConversationConditions(owner))
		.returning({ conversationId: conversations.conversationId });
	return released.length > 0;
}

/**
 * Push the Ownership lease deadline forward, under the epoch fence. Returns the
 * new deadline, or `null` when the lease is gone — which is the lost-lease
 * signal the drain halts and abandons on.
 *
 * The live-deadline conjunct is load-bearing, not belt-and-braces: Reclamation
 * clears the ownership columns without bumping the epoch (a lapsed lease and a
 * released one must look alike), so an epoch-only renewal would revive
 * ownership of a Conversation whose Runs Reclamation had just terminalized.
 */
export async function renewConversationLeaseTx(
	db: Database,
	owner: ConversationOwner,
): Promise<Date | null> {
	const [renewed] = await db
		.update(conversations)
		.set({ ownerUntil: conversationOwnershipLeaseDeadline() })
		.where(liveConversationOwnershipConditions(owner))
		.returning({ ownerUntil: conversations.ownerUntil });
	return renewed?.ownerUntil ?? null;
}

/** This acquisition's Conversation, identified by key and epoch. */
function ownedConversationConditions(owner: ConversationOwner) {
	return and(
		eq(conversations.userId, owner.userId),
		eq(conversations.conversationId, owner.conversationId),
		eq(conversations.epoch, owner.epoch),
	);
}

/**
 * The Ownership fence: this acquisition's Conversation, with its lease live.
 * Both conjuncts are required and cover different failures — the epoch fences a
 * lease superseded by a later acquisition, and the live deadline fences one that merely
 * lapsed with no successor, since a lapsed lease keeps its epoch.
 */
export function liveConversationOwnershipConditions(owner: ConversationOwner) {
	return and(
		ownedConversationConditions(owner),
		liveConversationOwnershipState(),
	);
}

/**
 * {@link liveConversationOwnershipConditions} as an in-statement `EXISTS`
 * predicate — the form a fenced write on another table carries inside the
 * statement that performs it. Deliberately a probe rather than a lock: fence
 * reads then never conflict with each other, only with brief acquisition and
 * release writes.
 */
export function liveConversationOwnershipExists(owner: ConversationOwner) {
	return sql`exists (select 1 from ${conversations} where ${liveConversationOwnershipConditions(owner)})`;
}

/**
 * Validate and lock live Ownership before a transaction mutates another table.
 * The `FOR SHARE` lock keeps ownership stable through commit, so release or
 * Reclamation cannot revoke the authorizing acquisition underneath the mutation.
 */
export async function lockLiveConversationOwnershipTx(
	tx: DbTx,
	owner: ConversationOwner,
	operation: string,
): Promise<void> {
	const [owned] = await tx
		.select({ conversationId: conversations.conversationId })
		.from(conversations)
		.where(liveConversationOwnershipConditions(owner))
		.for("share");
	if (!owned) rejectConversationOwnership(owner, operation);
}

/** Raise the canonical bounded rejection for a Conversation-owned mutation. */
export function rejectConversationOwnership(
	owner: Pick<ConversationOwner, "conversationId">,
	operation: string,
): never {
	throw new ConversationOwnershipFenceError(
		`${operation} for conversation ${owner.conversationId} rejected: ` +
			"the Ownership epoch is stale or its lease has lapsed",
	);
}
