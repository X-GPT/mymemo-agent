# Ownership is claimed per Conversation, fenced by an epoch

Status: accepted

Every resource a Run's execution writes is already Conversation-scoped —
`conversation_runtime` keyed `(user_id, conversation_id)`, `agent_sessions`
keyed `conversation_id`, `conversation_artifacts`, and the E2B sandbox
itself. Execution ownership was the one exception, held on the Run. Nearly
every awkward thing in the queue code traced to that single mismatch:
runtime writes borrowed authority by `EXISTS`-ing back into `runs`, the
sandbox was reconnected once per turn because no authority outlived a turn,
two ownership predicate variants existed (Run-scoped and user-bound), and
the `runs_one_active_per_conversation` partial unique index quietly doubled
as an ownership guarantee it was never declared to provide.

That last point corrects the record. Two comments — on the `runs` table and
atop `run-store.ts` — stated that v1 deliberately carries no fencing token
because "a run is claimed exactly once, so `locked_by` + `locked_until` is
the complete ownership fence." The conclusion held, but the reasoning did
not: per-statement lease checks do not compose across the multi-statement
transactions these helpers actually perform. What prevented two workers from
executing one Conversation was the partial unique index plus the terminal
NULL-out of the lease columns — structural safety from a constraint nobody
documented as load-bearing, not from the lease. The lease was closer to
advisory than the comments claimed.

We therefore move ownership to the Conversation. A worker claims a
Conversation, serves the Runs it had active at that moment one at a time in
submission order, and releases. Every Claim increments a per-Conversation
Ownership epoch, and every fenced write validates
`(conversation_id, epoch, owner_until > now())` against `conversations`.
Both conjuncts are required and cover different failures: the epoch fences a
lease that was superseded by a re-Claim, the deadline fences one that merely
lapsed with no successor. `owner_worker_id` then carries no safety weight —
an epoch names exactly one Claim, hence one worker — and survives only for
log correlation.

**The epoch is necessary here, not optional.** The original no-token argument
rested on claim-at-most-once. Conversation ownership deliberately breaks that
premise: a Conversation is claimed many times, by different workers, across
its life. That is precisely the condition under which a token stops being
redundant with worker identity.

A Claim serves a snapshot of the Runs active when it was taken; Runs
submitted mid-drain are deliberately left for a later Claim. This is not a
missed optimization. It bounds drain length by the admission depth bound
with no second constant, it sends a mid-drain arrival to the back of the
global queue by its own `created_at` rather than by policy, and it makes
release unconditional — `WHERE conversation_id = $c AND epoch = $epoch` —
where draining to empty would need a conditional release whose "zero rows
means work arrived, keep the lease and loop" subtlety is load-bearing. The
cost is that the common case, a follow-up typed while a turn runs, always
pays a release, a re-Claim, and an E2B reconnect. That is sub-second against
a turn measured in seconds to minutes.

A lapsed Ownership lease is deliberately not eligible for a fresh Claim.
Reclamation first terminalizes the vanished owner's `running` and
`interrupt_requested` Runs, taints the Workspace when command cleanup is
unproven, and clears Ownership. Never-started `queued` Runs remain queued and
make the released Conversation immediately eligible for its next Claim. This
ordering prevents a fresh holder from reconnecting to or writing alongside the
vanished holder before Reclamation establishes the durable boundary.

## Considered options

- **Keep ownership on the Run.** Rejected: it leaves the granularity
  mismatch, and therefore the borrowed authority and the undeclared
  index dependency, exactly where they are.
- **Conversation ownership without a token, relying on worker identity.**
  Rejected: `generateWorkerId()` is module-scope, so a same-process
  re-Claim makes the identity byte-identical between a stale holder and the
  live one, while the live holder's heartbeat makes the deadline true for
  both. Both conjuncts pass for a definitively stale writer.
- **Cache the epoch on `runs` to avoid a join per append.** Rejected as
  unsound: nothing invalidates the cached copy, so a stale worker's epoch
  still matches its own Run row. It does not fence.
- **A drain cap `K` bounding Runs served per Claim.** Superseded by
  snapshot semantics, which bounds it for free.

## Consequences

- The fence check adds one primary-key probe on `conversations` per fenced
  write. It takes no lock, so fence reads never conflict with each other,
  only with the brief Claim and release writes. A turn is on the order of
  15–20 fenced transactions, since a Tool group commits as one batch.
- Revocation is at-most-one-*after-commit*, not instantaneous: a write
  already in flight when the epoch bumps can still land. This is inherent to
  fencing tokens and is harmless here because a Run executes at most once —
  a late write lands on a Run that Reclamation is about to terminalize, never
  on one another worker is re-executing.
- `runs_one_active_per_conversation` is dropped, so at-most-one-executing
  becomes a program-order property of a single drain loop rather than a
  distributed invariant. The database still guarantees a single writer; what
  it no longer guarantees is that the writer starts one Run at a time. That
  is reviewable in one file and wants a comment saying so.
- `runs.locked_until` and `runs.heartbeat_at` are dropped —
  the latter is already write-only dead code today — along with
  `runs_stale_recovery_idx`. `locked_by` becomes
  `executed_by_worker_id` and survives the terminal transition as
  provenance, because a column named for a lock it no longer holds is how
  the next reader re-acquires the wrong belief this ADR corrects.
- The drain must distinguish a lost lease (halt, abandon, do not release)
  from a status rejection (the Run went terminal under us — continue to the
  next). Today's opaque `RunFenceError` cannot express that difference, so a
  typed fence outcome is a prerequisite for this work rather than an
  independent cleanup.
- The worker scaler must count Conversations, not Runs. Several active Runs
  on one Conversation are one claimable unit, so a Run-shaped metric would
  request up to `depth-bound` times the tasks that can help.
- The Ownership epoch is also recorded on `agent_sessions`, where it is
  provenance rather than a fence: it makes "which Claim wrote this
  transcript" answerable, closing a latent hazard where `listSessions`
  orders by mtime and a dead attempt's transcript is newest. It is
  deliberately *not* recorded on `conversation_runtime`, where the
  `conversations` check already prevents the stale write and a copy would
  only be a second thing to keep in sync.
- The exact Claim statement — a single `UPDATE` whose candidate subquery
  joins `runs` and takes `FOR UPDATE OF c SKIP LOCKED` on the
  `conversations` side alone — is unverified, as is the index shape it wants.
  The architectural decision does not depend on that form; a different
  statement would serve. Settle it before the spec.
