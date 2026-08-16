# Note: the dispatch publisher after AgentCore replaces Fargate

**Written 2026-08-15. Not a decision.** Nothing here is agreed or scheduled. It
exists so that whoever builds the production publisher does not re-derive it.

The end state assumed throughout: AgentCore replaces Fargate as the runtime for
all user traffic. There is no execution lane, the AgentCore canary is
decommissioned, and the Fargate pull loop is retired — so an AgentCore dispatch
becomes the only path from Run admission to execution.

## The shape

One publisher: a continuously running loop, single-flighted by a session-scoped
Postgres advisory lock taken and released around each tick. Each tick selects
unsent rows, sends them to the queue, and marks them.

There is no separate immediate publish at admission. The tick interval is short
enough — a couple of seconds — that the latency it saves is marginal against a
turn that runs for tens of seconds, and a second path would cost a second set of
failure modes for that margin.

## What one publisher buys

**chat-api needs no queue authority.** It writes the outbox row inside the
admission transaction it already runs, which is a plain database insert. Only
the loop talks to SQS. This is the point of a transactional outbox, and a second
publisher living in the admission path would give it away.

**No starvation hazard.** A tick-scoped lock makes the losing caller a no-op, so
any second publisher would have to claim rows by identity and stay off the lock.
With one publisher that constraint does not exist.

**Throughput is a batch-size question, not a structural one.** A tick is one
`SELECT`, batched sends, and one mark, so the ceiling sits orders of magnitude
above chat-product message rates. Size the batch deliberately anyway, since the
loop is now the only path to execution.

## Why the loop needs the lock

Its concurrency is a platform property, not a choice. The process runs
continuously, and an ECS service under the default rolling update keeps the old
task serving until the new one is healthy, so a deploy runs two of them even at
desired count one. Neither existing service sets deployment percentages, so both
already inherit that default. Configuration does not fix it safely: stopping the
old task first trades overlap for an outage, and ECS offers no at-most-once task
guarantee regardless.

An advisory lock is preferred to a per-row lease because liveness is enforced by
the database connection — Postgres releases a session lock when the backend
terminates, including on kill, crash, and task replacement — so there is no
expiry to tune against the loop interval. `agent-worker`'s cleanup loop already
works this way; see `tryWithAdvisoryLock` in `apps/agent-worker/src/cleanup/`.

## Scope the lock to the tick, not the process

```ts
export const PUBLISHER_ADVISORY_LOCK_KEY = 8_242_869_154_306_403;

const shutdown = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => shutdown.abort());
}

while (!shutdown.signal.aborted) {
	try {
		await tryWithAdvisoryLock(pool, PUBLISHER_ADVISORY_LOCK_KEY, () =>
			publisher.publishPending(),
		);
	} catch (error) {
		logger.error({ error }, "publish tick failed");
	}
	await sleep(intervalMs, shutdown.signal);
}
await pool.end();
```

The shutdown path has no lock responsibility. `tryWithAdvisoryLock` releases in
its own `finally`, so the signal handler only stops the loop, and handover needs
no drain protocol — a new task idles until the outgoing task's current tick
ends. The sleep sits outside the lock, so a standby task can acquire during the
gap instead of waiting out an interval.

Holding the lock for the process lifetime instead would cost two things. A hard
crash would always strand it, rather than only during a tick — an empty-outbox
tick is one `SELECT` returning nothing, so the lock is held on the order of one
percent of the time. And pinning one connection idle for days invites silent
loss: an RDS failover or proxy timeout drops it, Postgres releases the lock, the
process notices nothing, and a second publisher acquires while both believe they
are the singleton. Re-acquiring every tick re-verifies the invariant instead of
assuming it.

The `try`/`catch` is load-bearing in a loop, and inverts what would be right in
a Lambda. There, letting the exception end the invocation gives you the
platform's error metric for free. Here an uncaught throw exits the process, so a
transient queue failure becomes a container restart and a persistent one becomes
a restart loop. The loop needs the catch plus an explicit error metric.

`tryWithAdvisoryLock` returns `{ ran: false }` when another task holds the lock.
Emitting that as a metric is the only way to see how long deploy overlaps
actually last.

## Do not assume session affinity

An AgentCore dispatch carries the Conversation UUID as its Runtime-session
identity, but nothing may depend on invocations for one session reaching the
same compute. The outbox decouples delivery from admission in time, so a row
published after a crash arrives arbitrarily later, and delivery is at-least-once.
ADR-0020 already records that AgentCore does not serialize same-session
invocations.

Continuity does not need affinity: ADR-0005 rebuilds the transcript from the
Postgres resume pointer, and ADR-0007 makes the paused E2B sandbox the workspace
persistence. `CONTEXT.md` states it directly — a Runtime session "does not own
Run ordering or continuity."

## The outbox table

This is a migration of `canary_dispatch_outbox`, not a second table. With the
canary decommissioned there is nothing to isolate from, so its canary-shaped
constraints are removed rather than worked around: the `campaign_id` foreign key
to the Campaign record, the non-null `scenario_id`, and the `execution_lane`
check.

`execution_lane` disappears more widely than the outbox — from `conversations`,
from `CONVERSATION_EXECUTION_LANES` and `requireConversationExecutionLane`, from
`expectedExecutionLane` in the dispatch envelope, and from the consumer's
lane-mismatch poison branch that ADR-0020 specifies. ADR-0019 is superseded
outright; its entire subject ceases to exist.

`expires_at` loses its source when the Campaign does. Queued-Run expiration
already exists (`expireUnownedQueuedRunsTx`), so row lifetime can key off Run
state rather than carry its own timestamp.

## Open questions

- The tick interval, which is now the publication latency for every user
  message. Short enough to be invisible, long enough that the loop is not
  hammering Postgres for an empty result set.
- Whether to delete published rows rather than mark them. Deleting is probably
  right: the crash window is unchanged, and the table stays at pending-size
  instead of growing forever behind a retention sweep and a partial index.

  Deleting means re-homing a second job the outbox row quietly does. Overdue
  detection currently finds stuck work by joining outbox rows past the pending
  deadline to Runs that are still queued, so deleting on publish blinds it to
  exactly the case it exists to catch — dispatched, never acquired. "Queued Run
  older than N minutes" answers the same question from `runs` alone, but it
  becomes a separate watchdog rather than something the publisher gets free.

  Replay also stops being a flag and becomes a re-insert, which is workable
  because every envelope field is derivable from the Run and Conversation.
  Emit `publish_attempts` as a metric before deleting, or a double-publish bug
  leaves no evidence behind.
- Whether the consumer should pre-check terminal Run status before invoking.
  Independent of all the above and worth doing anyway: the consumer invokes the
  Runtime before it can learn the Run is already acquired, so every duplicate
  from SQS redelivery or `maxReceiveCount` costs a full invocation.

## Out of scope

Retiring the Fargate pull loop is much larger than the publisher and is not
addressed here. Conversation Ownership survives — the Runtime already acquires
atomically under it per ADR-0022 — but Claim, drain, expiration, and Reclamation
(ADR-0015) and the two-runtime premise of shared `RunServing` (ADR-0023) all
need their own treatment.

## See also

ADR-0020 (the outbox and its at-least-once contract), ADR-0022 (atomic exact
acquisition), ADR-0019 (superseded by the end state assumed here).
