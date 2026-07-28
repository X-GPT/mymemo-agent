# Gate-closed cutover to Conversation ownership

Status: accepted

ADR-0002 refused a coexistence flag between the prototype and split-runtime
paths because they enforced "one active turn per conversation" with
different authorities, leaving no single authority for the invariant: two
turns could run concurrently on one conversation, each legal under its own.
ADR-0015 recreates that shape during a rolling deploy. An old worker claims
Runs directly and never consults the Ownership lease; it was safe only
because `runs_one_active_per_conversation` was an authority both generations
respected, and ADR-0015 drops that index. Old and new workers would share no
authority at all.

Unlike ADR-0002 we cannot add "nothing deployed exercises the other path" —
the split runtime is live. So the cutover closes the exposure gate, lets
in-flight Runs drain, scales `agent-worker` to zero, applies the migration
and deploys, then scales up and reopens the gate. There is exactly one
authority at every instant, because for part of the window there is no
worker at all.

The alternative was a two-phase rollout: ship the lease alongside Run-level
claiming with the index and a depth bound of one still in force, then drop
the index and raise the bound once the fleet is uniform. It avoids downtime
and it would work. We rejected it because the phase-one shim is *dual
ownership predicates* — the precise defect ADR-0015 exists to remove. Paying
to build the disease as a migration step is only worth it if downtime is
genuinely unavailable, and here it is not: the surface is Statsig-gated, and
the gate already fails closed, so the window uses machinery we have rather
than machinery we write.

## Consequences

- Users see `403 Agent is not enabled` for the length of the window, and any
  turn still running when the drain deadline elapses dies as `error`.
- This is the assumption to re-test if the product's exposure widens before
  the work lands. If a maintenance window stops being acceptable, the
  two-phase rollout becomes correct and this ADR should be superseded rather
  than worked around.
- The migration is not additive-only — dropped columns and a dropped index
  mean the previous worker image cannot run against the new schema. Rollback
  is a restore, not a redeploy, so the window must not be treated as
  reversible once workers are back up and writing.
