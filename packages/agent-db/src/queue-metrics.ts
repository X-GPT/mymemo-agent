import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { conversations, runs } from "./schema";

export interface ConversationQueueMetrics {
	demandConversations: number;
	ownedConversations: number;
}

/**
 * Read the Postgres-backed queue depth used by the worker scaler, counted in
 * Conversations rather than Runs: under Conversation ownership (ADR-0015) the
 * scheduling unit is the Conversation — several Active Runs on one Conversation
 * are one drain — so a Run-shaped metric would request tasks that cannot
 * possibly help. Demand means at least one recent queued Run and no live
 * Ownership lease: an unowned Conversation can be Claimed, while a lapsed one
 * first needs Reclamation. Owned means a live lease with a recent Active Run —
 * a Conversation occupying a worker slot for work inside the window.
 * Deliberately reads no Run lease column — the Run lease is on its way out.
 *
 * The one-day recency window applies to both counts, as it did when the
 * metric was Run-shaped. It is deliberately stricter than the Claim's own
 * Claim eligibility (`claimConversationTx` has no recency filter): a Conversation
 * whose only queued Run is over a day old is still claimable by a worker, but
 * scaling on it would hold tasks up for work that has already sat unserved
 * past any queue-age expectation. The owned side windows the Conversation's
 * Active Runs the same way, preserving the old metric's exclusion of live
 * work older than the window.
 *
 * Both counts drive from what they are proportional to, like the Claim
 * itself: demand walks the queued `runs` (`runs_queue_claim_idx`) and
 * probes `conversations` by primary key; owned walks the live-lease partial
 * index and probes the Conversation's Active Runs
 * (`runs_conversation_active_idx`) — so neither scans the unboundedly growing
 * `conversations` table.
 * Written against `db.execute` rather than the select builder because a
 * single-table select renders template column refs unqualified, which breaks
 * cross-table predicates like the join below.
 */
export async function readConversationQueueMetrics(
	db: Database,
): Promise<ConversationQueueMetrics> {
	const result = await db.execute<{
		demand_conversations: number;
		owned_conversations: number;
	}>(sql`
		select
			(select count(distinct (${runs.userId}, ${runs.conversationId}))::int
			   from ${runs}
			   join ${conversations}
			     on ${conversations.userId} = ${runs.userId}
			    and ${conversations.conversationId} = ${runs.conversationId}
			  where ${runs.status} = 'queued'
			    and ${runs.createdAt} > now() - interval '1 day'
			    and (${conversations.ownerUntil} is null or ${conversations.ownerUntil} <= now())
			) as demand_conversations,
			(select count(*)::int
			   from ${conversations}
			  where ${conversations.ownerUntil} > now()
			    and exists (
			      select 1 from ${runs}
			       where ${runs.userId} = ${conversations.userId}
			         and ${runs.conversationId} = ${conversations.conversationId}
			         and ${runs.status} in ('queued', 'running', 'interrupt_requested')
			         and ${runs.createdAt} > now() - interval '1 day'
			    )) as owned_conversations
	`);
	const [row] = result.rows;

	return {
		demandConversations: row?.demand_conversations ?? 0,
		ownedConversations: row?.owned_conversations ?? 0,
	};
}
