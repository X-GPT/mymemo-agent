import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import { FARGATE_EXECUTION_LANE } from "./execution-lane";
import { conversations, runs } from "./schema";

/**
 * Conversation ownership and the Claim protocol (ADR-0015): take exclusive
 * execution ownership of one Conversation, learn which Runs that Claim will
 * serve, renew that ownership, and release it — plus the fence every owned
 * write validates against.
 *
 * A worker Claims a Conversation, serves the Runs it had queued at that moment
 * one at a time in submission order, and releases. Every Claim increments the
 * Conversation's Ownership epoch. Runs submitted mid-drain are deliberately
 * left for a later Claim — that is what bounds drain length by the admission
 * depth bound with no second constant, sends a mid-drain arrival to the back of
 * the global queue by its own `created_at`, and lets release be unconditional
 * rather than carrying a "zero rows means work arrived, keep the lease and
 * loop" subtlety.
 *
 * This module is deliberately the whole of ADR-0015. No Run-scoped lease or
 * competing ownership predicate exists.
 *
 * Lock order is global and stated once: `conversations` before `runs`. The
 * Claim below holds to it by locking only the `conversations` side of its
 * candidate join; the epoch fence takes no lock and does not participate.
 */

/**
 * How far ahead a Claim or renewal pushes `owner_until`: a 60s hold renewed on
 * the worker's 15s heartbeat, allowing four missed renewals before the
 * Conversation becomes reclaimable.
 */
export const CONVERSATION_OWNERSHIP_LEASE_MS = 60_000;

/** A Claim and a renewal must push the deadline the same distance. */
function leaseDeadline() {
	return sql`now() + (${CONVERSATION_OWNERSHIP_LEASE_MS} * interval '1 millisecond')`;
}

/** Whether a fetched Conversation row currently carries live Ownership. */
export function hasLiveConversationOwnership(
	conversation: { ownerWorkerId: string | null; ownerUntil: Date | null },
	now: Date,
): conversation is { ownerWorkerId: string; ownerUntil: Date } {
	return (
		conversation.ownerWorkerId !== null &&
		conversation.ownerUntil !== null &&
		conversation.ownerUntil.getTime() > now.getTime()
	);
}

/**
 * One Claim of a Conversation: the Conversation it took and the Ownership epoch
 * that Claim was given. This is the whole authority a fenced write needs — the
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
 * A Conversation this worker now owns, the epoch that names this Claim, its
 * lease deadline, and the Runs the Claim will serve.
 */
export interface ClaimedConversation extends ConversationOwner {
	ownerUntil: Date;
	/** The queued Runs at Claim time, oldest submission first. */
	runIds: string[];
}

/**
 * Claim one claimable Conversation — at least one queued Run and no Ownership
 * lease — and snapshot the Runs it will serve. A lapsed lease is deliberately
 * not a Claim candidate: Reclamation must first terminalize the vanished
 * owner's Runs, taint its Workspace, and clear the ownership columns. Only then
 * may a later Run take a fresh Claim.
 *
 * The Claim is a single `UPDATE` whose candidate subquery joins `runs`, orders
 * by the Run's `created_at`, and takes `FOR UPDATE OF c SKIP LOCKED` on the
 * `conversations` side alone, so the global `conversations`-before-`runs` lock
 * order holds. Concurrent claimants skip each other's candidate rather than
 * blocking or double-claiming; a claimant that skips retries on its next tick,
 * so contention is latency, not starvation.
 *
 * **The no-join alternative is rejected, not an option.** Replacing the join
 * with an `EXISTS` plus a correlated `min(created_at)` order key measured 7697
 * buffers / 19.7 ms against this shape's 7 buffers / 0.074 ms for the same
 * candidate at 2000 Conversations x 3 queued Runs, because it plans a Sort plus
 * a per-row SubPlan aggregate. A two-statement "select the candidate `FOR
 * UPDATE SKIP LOCKED`, then update it by key" produces an identical candidate
 * plan and stays available as a portability fallback only, at one extra round
 * trip.
 *
 * **No index is added for the Claim.** `runs_queue_claim_idx` — originally
 * added for the retired Run-scoped claim and retained for this Claim — is what
 * makes this plan sort-free, with LockRows directly under Limit; that placement
 * is what makes SKIP LOCKED skip in queue order rather than in scan order.
 *
 * Claim cost is O(queued Runs ahead of the first claimable Conversation), since
 * the candidate scan walks `runs` in global `created_at` order and probes
 * `conversations` per row: every queued Run belonging to an already-owned
 * Conversation is a row the scan walks past. The admission depth bound
 * therefore bounds claim cost as well as drain length, and every idle worker
 * pays it on every tick.
 *
 * The scaler's demand metric (`queue-metrics.ts`) counts lapsed leases so it can
 * start a worker to perform Reclamation. After Reclamation clears the Ownership
 * columns, the Conversation becomes eligible for this Claim predicate.
 */
export async function claimConversationTx(
	db: Database,
	input: { workerId: string },
): Promise<ClaimedConversation | null> {
	return await db.transaction(async (tx) => {
		const [claimed] = await tx
			.update(conversations)
			.set({
				ownerWorkerId: input.workerId,
				ownerUntil: leaseDeadline(),
				epoch: sql`${conversations.epoch} + 1`,
			})
			.where(
				sql`(${conversations.userId}, ${conversations.conversationId}) = (
					select c.user_id, c.conversation_id
					  from ${conversations} c
					  join ${runs} r using (user_id, conversation_id)
					 where r.status = 'queued'
					   and c.execution_lane = ${FARGATE_EXECUTION_LANE}
					   and c.owner_until is null
					 order by r.created_at
					   for update of c skip locked
					 limit 1)`,
			)
			.returning({
				userId: conversations.userId,
				conversationId: conversations.conversationId,
				epoch: conversations.epoch,
				ownerUntil: conversations.ownerUntil,
			});
		if (!claimed) return null;
		const { ownerUntil } = claimed;
		if (!ownerUntil) {
			throw new Error(
				`claim of conversation ${claimed.conversationId} wrote no lease deadline`,
			);
		}

		// The snapshot shares the Claim's transaction, and the reason is the
		// drain-length bound, not safety. Both placements are safe — the Claim's
		// UPDATE holds the `conversations` row lock and admission takes that same
		// row `FOR UPDATE` before inserting, so an admission either committed
		// before the lock (inside the snapshot) or waits for it (deferred to the
		// next Claim) — and both were measured never to double-serve, lose, or
		// double-terminalize a Run. What differs is only the bound: taken here, 0
		// Runs were served past their own Claim; taken after the Claim commits, 44
		// were. A split placement is silently unbounded, and a reviewer checking
		// only correctness would wave it through, so do not separate these.
		const snapshot = await tx
			.select({ runId: runs.runId })
			.from(runs)
			.where(
				and(
					eq(runs.userId, claimed.userId),
					eq(runs.conversationId, claimed.conversationId),
					eq(runs.status, "queued"),
				),
			)
			.orderBy(runs.createdAt, runs.runId);

		return {
			userId: claimed.userId,
			conversationId: claimed.conversationId,
			epoch: claimed.epoch,
			ownerUntil,
			runIds: snapshot.map((run) => run.runId),
		};
	});
}

/**
 * Release the Claim. Unconditional on `(conversation, epoch)`: snapshot drain
 * already deferred mid-drain arrivals, so there is no "work arrived, keep the
 * lease" case to get wrong. A superseded holder matches zero rows and therefore
 * cannot take the Conversation back from its successor. Returns whether this
 * Claim was still the current one.
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
		.where(claimedConversationConditions(owner))
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
		.set({ ownerUntil: leaseDeadline() })
		.where(liveConversationOwnershipConditions(owner))
		.returning({ ownerUntil: conversations.ownerUntil });
	return renewed?.ownerUntil ?? null;
}

/** This Claim's Conversation, identified by key and epoch. */
function claimedConversationConditions(owner: ConversationOwner) {
	return and(
		eq(conversations.userId, owner.userId),
		eq(conversations.conversationId, owner.conversationId),
		eq(conversations.epoch, owner.epoch),
	);
}

/**
 * The Ownership fence: this Claim's Conversation, with its lease still live.
 * Both conjuncts are required and cover different failures — the epoch fences a
 * lease superseded by a re-Claim, and the live deadline fences one that merely
 * lapsed with no successor, since a lapsed lease keeps its epoch.
 */
export function liveConversationOwnershipConditions(owner: ConversationOwner) {
	return and(
		claimedConversationConditions(owner),
		sql`${conversations.ownerUntil} > now()`,
	);
}

/**
 * {@link liveConversationOwnershipConditions} as an in-statement `EXISTS`
 * predicate — the form a fenced write on another table carries inside the
 * statement that performs it. Deliberately a probe rather than a lock: fence
 * reads then never conflict with each other, only with the brief Claim and
 * release writes.
 */
export function liveConversationOwnershipExists(owner: ConversationOwner) {
	return sql`exists (select 1 from ${conversations} where ${liveConversationOwnershipConditions(owner)})`;
}

/**
 * Validate and lock a live Claim before a transaction mutates another table.
 * The `FOR SHARE` lock keeps ownership stable through commit, so release or
 * Reclamation cannot revoke the authorizing Claim underneath the mutation.
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
