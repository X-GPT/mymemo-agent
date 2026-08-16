# Publish AgentCore dispatch through one advisory-locked loop

Status: accepted (2026-08-16). Amends ADR-0020's publisher consequences.

One publisher: a continuously running loop, single-flighted by a session-scoped
Postgres advisory lock taken and released around each tick. Each tick selects
unpublished outbox rows, sends them to the queue, and marks them published.
There is no immediate publish in the admission path: chat-api writes only the
outbox row inside the admission transaction it already runs and holds no queue
authority. The tick interval is the publication latency for every user message
— a couple of seconds, invisible against a turn measured in tens of seconds —
and a second publish path would buy back that margin at the cost of a second
set of failure modes.

The lock is scoped to the tick, not the process. Liveness is enforced by the
database connection — Postgres releases a session advisory lock when the
backend terminates, including on kill, crash, and task replacement — so there
is no expiry to tune against the loop interval, and the two-task overlap of a
rolling deploy makes the losing task a no-op rather than a second publisher.
An ambiguous send (a crash between `SendMessage` and the mark) needs no
compensating write: delivery is at-least-once and Postgres Durable acquisition
remains the duplicate-execution authority. Published rows are marked, not
deleted: deleting would blind overdue detection to exactly the case it exists
to catch — dispatched but never acquired — and would turn manual replay into
re-insertion, to shrink a table that stays at pending size anyway.

## Considered options

- **A scheduled Lambda publisher (the canary shape).** Rejected because
  EventBridge's one-minute floor makes worst-case publication latency
  user-visible. In the canary it was a repair path behind an immediate
  in-process publish that production deliberately does not have.
- **An immediate publish in the admission path.** Rejected because it hands
  chat-api SQS authority and a second failure surface to save a couple of
  seconds — giving away the point of the transactional outbox.
- **Per-row publish leases as the singleton mechanism.** Rejected as the
  primary authority: connection-scoped liveness needs no lease-versus-interval
  tuning. Whether the tick's implementation retains the claim/confirm columns
  internally is an implementation choice this contract does not depend on.
- **Delete rows on publish.** Rejected for now: the crash window is unchanged
  either way, and marking preserves overdue detection, flag-based replay, and
  `publish_attempts` evidence. Revisit only if retention ever becomes a real
  cost.

## Consequences

- The compute home is constrained only to a long-lived process. The
  agent-worker process, which outlives the rollout and already runs
  advisory-locked maintenance loops, is the natural first home; moving the
  loop later does not change this contract.
- The EventBridge repair rule and the control-Lambda immediate publish retire
  with the canary.
- The loop emits its lost-lock outcome and a pending-age metric; publisher
  observability replaces the Campaign's overdue marking as the way stuck
  dispatch is seen.
