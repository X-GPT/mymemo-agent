/**
 * Shared ownership vocabulary and SQL predicates. Worker-scoped mutations use
 * the Run/Conversation/worker/lease fence; Conversation runtime and terminal
 * mutations add the trusted user identity. Runtime pointer updates use the
 * user-bound predicate's `EXISTS` form inside the write itself.
 *
 * The Conversation Ownership epoch fence (ADR-0015) lives here too. It is the
 * fence the Claim protocol hands out, and the one every fenced write moves to;
 * the Run-lease predicates above it are what those writes still evaluate today.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { conversations, runs } from "./schema";

/** Run identity and lease holder required for any worker-owned mutation. */
export interface RunMutationOwner {
	conversationId: string;
	runId: string;
	workerId: string;
}

/** User-bound owner identity for Conversation-scoped Run mutations. */
export interface UserRunMutationOwner extends RunMutationOwner {
	userId: string;
}

/**
 * An ownership/status fence rejected a worker mutation. The caller must stop
 * treating the Run as its own; recovery or the actual owner is now in charge.
 */
export class RunFenceError extends Error {
	override name = "RunFenceError" as const;
}

/** Run statuses under which the owning worker may mutate private Run state. */
const OWNED_ACTIVE_STATUSES = ["running", "interrupt_requested"] as const;

/** Run identity and live lease, without imposing a status class. */
function runLeaseConditions(owner: RunMutationOwner) {
	return and(
		eq(runs.runId, owner.runId),
		eq(runs.conversationId, owner.conversationId),
		eq(runs.lockedBy, owner.workerId),
		sql`${runs.lockedUntil} > now()`,
	);
}

/** The ownership predicate for Run-scoped mutations. */
export function ownedRunConditions(owner: RunMutationOwner) {
	return and(
		runLeaseConditions(owner),
		inArray(runs.status, [...OWNED_ACTIVE_STATUSES]),
	);
}

/** User-bound Run identity and live lease, without imposing a status class. */
export function runLeaseByUserConditions(owner: UserRunMutationOwner) {
	return and(runLeaseConditions(owner), eq(runs.userId, owner.userId));
}

/** The stronger ownership predicate for user-owned Conversation state. */
export function ownedRunByUserConditions(owner: UserRunMutationOwner) {
	return and(
		runLeaseByUserConditions(owner),
		inArray(runs.status, [...OWNED_ACTIVE_STATUSES]),
	);
}

/** {@link ownedRunByUserConditions} as an in-statement `EXISTS` predicate. */
export function ownedRunByUserExists(owner: UserRunMutationOwner) {
	return sql`exists (select 1 from ${runs} where ${ownedRunByUserConditions(owner)})`;
}

/**
 * One Claim of a Conversation: the Conversation it took and the Ownership epoch
 * that Claim was given. This is the whole authority a fenced write needs — the
 * owning worker's id is provenance and deliberately absent here.
 */
export interface ConversationOwner {
	userId: string;
	conversationId: string;
	epoch: number;
}

/**
 * The Ownership epoch fence, as an in-statement `EXISTS` probe on the
 * `conversations` primary key. Both conjuncts are required and cover different
 * failures: the epoch fences a lease superseded by a re-Claim, and the live
 * deadline fences one that merely lapsed with no successor — a lapsed lease
 * keeps its epoch, so the epoch alone would let a worker whose Conversation is
 * about to be reclaimed keep writing.
 *
 * Deliberately a probe rather than a lock: fence reads then never conflict with
 * each other, only with the brief Claim and release writes.
 */
export function conversationEpochExists(owner: ConversationOwner) {
	return sql`exists (
		select 1 from ${conversations} c
		 where c.user_id = ${owner.userId}
		   and c.conversation_id = ${owner.conversationId}
		   and c.epoch = ${owner.epoch}
		   and c.owner_until > now())`;
}

/** Raise the canonical bounded rejection for an owned worker mutation. */
export function rejectRunFence(
	owner: RunMutationOwner,
	operation: string,
): never {
	throw new RunFenceError(
		`${operation} for conversation ${owner.conversationId} rejected: ` +
			`worker ${owner.workerId} no longer owns run ${owner.runId}`,
	);
}
