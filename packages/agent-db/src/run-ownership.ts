/**
 * Transitional Run-lease vocabulary retained until #402 removes the bridge.
 * Conversation-scoped mutations no longer use these predicates; they validate
 * the Conversation's live Ownership fence directly.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { runs } from "./schema";

/** Run identity and lease holder required for any worker-owned mutation. */
export interface RunMutationOwner {
	conversationId: string;
	runId: string;
	workerId: string;
}

/** A worker ownership/status fence rejected a mutation. */
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
