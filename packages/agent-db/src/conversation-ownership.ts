import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import type { ConversationOwner } from "./run-ownership";
import { conversations, runs } from "./schema";

/**
 * The Claim protocol (ADR-0015): take exclusive execution ownership of one
 * Conversation, learn which Runs that Claim will serve, renew that ownership,
 * and release it.
 *
 * A worker Claims a Conversation, serves the Runs it had queued at that moment
 * one at a time in submission order, and releases. Every Claim increments the
 * Conversation's Ownership epoch, and `conversationEpochExists` is the fence
 * every owned write validates against. Runs submitted mid-drain are
 * deliberately left for a later Claim — that is what bounds drain length by the
 * admission depth bound with no second constant, sends a mid-drain arrival to
 * the back of the global queue by its own `created_at`, and lets release be
 * unconditional rather than carrying a "zero rows means work arrived, keep the
 * lease and loop" subtlety.
 *
 * Lock order is global and stated once: `conversations` before `runs`. The
 * Claim below holds to it by locking only the `conversations` side of its
 * candidate join; the epoch fence takes no lock and does not participate.
 */

/**
 * How far ahead a Claim or a renewal pushes `owner_until`. The same 60s hold
 * the Run lease uses, renewed on the worker's 15s heartbeat — four missed
 * renewals before the Conversation becomes reclaimable.
 */
const OWNERSHIP_LEASE_MS = 60_000;

/** One queued Run inside a Claim's snapshot. */
export interface ClaimedRun {
	runId: string;
	createdAt: Date;
}

/**
 * A Conversation this worker now owns, the epoch that names this Claim, its
 * lease deadline, and the Runs the Claim will serve.
 */
export interface ClaimedConversation extends ConversationOwner {
	ownerUntil: Date;
	/** The queued Runs at Claim time, oldest submission first. */
	runs: ClaimedRun[];
}

/**
 * Claim one claimable Conversation — at least one queued Run, no live Ownership
 * lease — and snapshot the Runs it will serve.
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
 * **No index is added for the Claim.** `runs_queue_claim_idx` — which already
 * exists, for the Run-scoped claim — is what makes this plan sort-free, with
 * LockRows directly under Limit; that placement is what makes SKIP LOCKED skip
 * in queue order rather than in scan order.
 *
 * Claim cost is O(queued Runs ahead of the first claimable Conversation), since
 * the candidate scan walks `runs` in global `created_at` order and probes
 * `conversations` per row: every queued Run belonging to an already-owned
 * Conversation is a row the scan walks past. The admission depth bound
 * therefore bounds claim cost as well as drain length, and every idle worker
 * pays it on every tick.
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
				ownerUntil: sql`now() + (${OWNERSHIP_LEASE_MS} * interval '1 millisecond')`,
				epoch: sql`${conversations.epoch} + 1`,
			})
			.where(
				sql`(${conversations.userId}, ${conversations.conversationId}) = (
					select c.user_id, c.conversation_id
					  from ${conversations} c
					  join ${runs} r using (user_id, conversation_id)
					 where r.status = 'queued'
					   and (c.owner_until is null or c.owner_until <= now())
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
			.select({ runId: runs.runId, createdAt: runs.createdAt })
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
			runs: snapshot,
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
		.set({
			ownerUntil: sql`now() + (${OWNERSHIP_LEASE_MS} * interval '1 millisecond')`,
		})
		.where(
			and(
				ownedConversationConditions(owner),
				sql`${conversations.ownerUntil} > now()`,
			),
		)
		.returning({ ownerUntil: conversations.ownerUntil });
	return renewed?.ownerUntil ?? null;
}

/** This Claim's Conversation, identified by key and epoch. */
function ownedConversationConditions(owner: ConversationOwner) {
	return and(
		eq(conversations.userId, owner.userId),
		eq(conversations.conversationId, owner.conversationId),
		eq(conversations.epoch, owner.epoch),
	);
}
