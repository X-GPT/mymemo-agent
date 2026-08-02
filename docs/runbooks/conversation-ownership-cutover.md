# Conversation Ownership cutover

This is the one-time deployment procedure for removing the legacy Run lease.
The old worker Claims Runs directly and the new worker Claims Conversations;
they must never run against the same post-migration database. Keep the agent
exposure gate closed for the whole window.

## Pre-flight

Run the Claim plan once, by hand, against representative data on the same
Postgres major as production. Use a transaction so the row lock is released
immediately:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT c.user_id, c.conversation_id
FROM conversations c
JOIN runs r USING (user_id, conversation_id)
WHERE r.status = 'queued'
  AND c.owner_until IS NULL
ORDER BY r.created_at
FOR UPDATE OF c SKIP LOCKED
LIMIT 1;
ROLLBACK;
```

Confirm the plan has no `Sort` node and has `LockRows` directly under `Limit`.
That shape makes claimants skip locked Conversations in queue order rather than
scan order. Record the plan with the deployment change. Do not turn it into a CI
assertion: planner and statistics changes can alter EXPLAIN output without a
queue-protocol regression.

The one-time generated-schema audit compared
`packages/agent-db/drizzle/meta/0017_snapshot.json` with
`packages/agent-db/src/schema.ts` across all four state tables touched by the
ownership and continuity sequence. It confirmed:

- `conversations` has `owner_worker_id`, `owner_until`, and `epoch`, plus the
  partial Reclamation index;
- `conversation_runtime.agent_session_id` is present;
- `agent_sessions.epoch` and its transcript indexes are present; and
- `runs.executed_by_worker_id` remains while the three Run-lease columns and
  stale-recovery index are absent.

The final generated migration DDL contains exactly:

- `DROP INDEX runs_stale_recovery_idx`;
- drops of `runs.locked_by`, `runs.locked_until`, and `runs.heartbeat_at`;
- no drop or rewrite of `runs.executed_by_worker_id`.

## Deploy

1. Close `mymemo_agent_split_runtime_enabled` and let admitted Runs finish.
2. Scale the `agent-worker` ECS service to zero and confirm no worker task
   remains running.
3. Apply the agent-database migration while the worker count is zero.
4. Deploy the matching chat-api and agent-worker images.
5. Scale the worker service back to its normal desired count and confirm it is
   healthy and Claiming Conversations.
6. Run the deterministic end-to-end lane, then reopen the exposure gate.

The zero-worker interval is load-bearing: an old worker never consults the
Conversation Ownership lease, and the Run index both generations previously
respected no longer exists after the migration.

## Data and rollback

The surface is not public during this cutover, so existing agent rows may be
discarded. The migration requires no backfill. If rollback is necessary, scale
workers to zero, reset the agent database to the schema shipped by the target
image, redeploy that image, and scale up again. Do not restore an agent-database
backup merely to preserve pre-cutover rows.
