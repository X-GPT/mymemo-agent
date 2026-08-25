import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import { conversations } from "./schema";

/** Ownership is Conversation-scoped; no Run-scoped lease exists. */

/** Shared duration for Conversation Ownership and Response authority. */
export const CONVERSATION_EXECUTION_AUTHORITY_MS = 60_000;

export function conversationExecutionAuthorityClock(now?: Date) {
	return now ? sql`${now}::timestamptz` : sql`now()`;
}

export function conversationExecutionAuthorityDeadline(now?: Date) {
	return sql`${conversationExecutionAuthorityClock(now)} + (${CONVERSATION_EXECUTION_AUTHORITY_MS} * interval '1 millisecond')`;
}

export function liveConversationExecutionAuthorityState(now?: Date) {
	return sql<boolean>`${conversations.ownerUntil} > ${conversationExecutionAuthorityClock(now)}`;
}

export function liveConversationOwnershipState(now?: Date) {
	return sql<boolean>`${conversations.ownerWorkerId} is not null
		and ${liveConversationExecutionAuthorityState(now)}`;
}

/** Fenced-write authority; worker identity is provenance, not authority. */
export interface ConversationOwner {
	userId: string;
	conversationId: string;
	epoch: number;
}

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
 * new deadline, or `null` when the lease is gone — which signals the active
 * invocation to halt and abandon execution.
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
		.set({ ownerUntil: conversationExecutionAuthorityDeadline() })
		.where(liveConversationOwnershipConditions(owner))
		.returning({ ownerUntil: conversations.ownerUntil });
	return renewed?.ownerUntil ?? null;
}

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
