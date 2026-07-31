import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { conversations, runs } from "./schema";

export interface ConversationQueueMetrics {
	claimableConversations: number;
	ownedConversations: number;
}

/**
 * Read the Postgres-backed queue depth used by the worker scaler, counted in
 * Conversations rather than Runs: under Conversation ownership (ADR-0015) the
 * claimable unit is the Conversation — several Active Runs on one Conversation
 * are one drain — so a Run-shaped metric would request tasks that cannot
 * possibly help. Claimable means at least one recent queued Run and no live
 * Ownership lease; owned means a live lease, regardless of what remains
 * queued, because that Conversation occupies a worker slot until release.
 * Deliberately reads no Run lease column — the Run lease is on its way out.
 *
 * The one-day recency window is deliberately stricter than the Claim's own
 * claimability (`claimConversationTx` has no recency filter): a Conversation
 * whose only queued Run is over a day old is still claimable by a worker, but
 * scaling on it would hold tasks up for work that has already sat unserved
 * past any queue-age expectation. Owned needs no window — a live lease is at
 * most one renewal ahead of now.
 *
 * Both counts drive from what they are proportional to, like the Claim
 * itself: claimable walks the queued `runs` (`runs_queue_claim_idx`) and
 * probes `conversations` by primary key, owned walks the live-lease partial
 * index — so neither scans the unboundedly growing `conversations` table.
 * Written against `db.execute` rather than the select builder because a
 * single-table select renders template column refs unqualified, which breaks
 * cross-table predicates like the join below.
 */
export async function readConversationQueueMetrics(
	db: Database,
): Promise<ConversationQueueMetrics> {
	const result = await db.execute<{
		claimable_conversations: number;
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
			) as claimable_conversations,
			(select count(*)::int
			   from ${conversations}
			  where ${conversations.ownerUntil} > now()) as owned_conversations
	`);
	const [row] = result.rows;

	return {
		claimableConversations: row?.claimable_conversations ?? 0,
		ownedConversations: row?.owned_conversations ?? 0,
	};
}
