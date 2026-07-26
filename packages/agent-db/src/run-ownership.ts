import { and, eq, inArray, sql } from "drizzle-orm";
import { runs } from "./schema";

/** Run identity and lease holder required for any worker-owned mutation. */
export interface RunMutationOwner {
	conversationId: string;
	runId: string;
	workerId: string;
}

/** Full owner identity used when mutating Conversation-scoped runtime state. */
export interface RunOwnershipRef extends RunMutationOwner {
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

/** The ownership predicate for Run-scoped mutations. */
export function ownedRunConditions(owner: RunMutationOwner) {
	return and(
		eq(runs.runId, owner.runId),
		eq(runs.conversationId, owner.conversationId),
		inArray(runs.status, [...OWNED_ACTIVE_STATUSES]),
		eq(runs.lockedBy, owner.workerId),
		sql`${runs.lockedUntil} > now()`,
	);
}

/** The stronger ownership predicate for user-owned Conversation state. */
export function ownedRunByUserConditions(owner: RunOwnershipRef) {
	return and(ownedRunConditions(owner), eq(runs.userId, owner.userId));
}

/** {@link ownedRunByUserConditions} as an in-statement `EXISTS` predicate. */
export function ownedRunExists(owner: RunOwnershipRef) {
	return sql`exists (select 1 from ${runs} where ${ownedRunByUserConditions(owner)})`;
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
