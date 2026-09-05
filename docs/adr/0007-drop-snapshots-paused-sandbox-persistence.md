# Drop E2B snapshots; paused-sandbox-only workspace persistence

Status: accepted

Superseded (2026-09-05) by [ADR-0035](./0035-serve-chat-through-a-lambda-front-and-a-code-interpreter-hand.md): paused-sandbox persistence retires at the v1 cutover.

The design (Task 4.1, Task 5.3, Milestone 8) made E2B **snapshots** the
durability layer for a conversation's workspace: snapshot-if-dirty at each
turn's end through a barrier, restore from `latest_snapshot_id` when the paused
sandbox is lost, rotate `previous`/`latest`, and reap on a retention window.
This decision removes that layer entirely to cut the complexity it carried
(the snapshot barrier, dirty tracking, `dirty_uncheckpointed` recovery, snapshot
rotation/retention, and the restore path).

The Task 4.1 spike proved the properties that make snapshots unnecessary for
v1: E2B `onTimeout: 'pause'` preserves the sandbox filesystem, `Sandbox.connect`
auto-resumes a paused sandbox in ~250 ms, and paused sandboxes are retained
indefinitely (no TTL). E2B's published limits (verified: e2b.dev/pricing,
e2b.dev/docs/sandbox/persistence) put the concurrent cap on **running**
sandboxes (hobby 20 / pro 100) and bill "per second of a running sandbox";
disk is **per-sandbox** (hobby 10 GiB / pro 20 GiB), not a shared account quota.
So a paused sandbox held indefinitely per conversation surfaces no documented
cost, cap, or quota pressure on the current tier.

**The persistence model becomes:** the paused E2B sandbox *is* the workspace,
pointed to by `conversation_runtime.sandbox_id`. Turn ends → stop renewing →
the sandbox idle-pauses. Next turn → `connect(sandbox_id)` → auto-resume, files
intact. Provisioning collapses to: pointer set and not tainted → connect; else
(connect fails, or tainted) → create a fresh sandbox and repoint. There is no
"restore from snapshot" middle path.

The accepted trade: workspace files are now **best-effort, not durable** — if a
sandbox is ever lost (killed on taint/error, or an E2B incident), that
conversation's files are gone and the next turn starts empty. Crucially,
conversation **continuity is unaffected**: the model's cross-turn memory lives
in Postgres `agent_sessions` (ADR-0005), not in the sandbox, so the agent still
remembers the conversation — it may only find its scratch files gone.

## Considered Options

- **Snapshots as a durable, bounded-cost checkpoint layer** (the prior design) —
  rejected now: durable and cost-bounded, but it is the single largest source of
  workspace-lifecycle complexity, and the spike + pricing show a paused sandbox
  already persists indefinitely at no documented cost on our tier.
- **Paused-sandbox-only persistence** (chosen) — best-effort file durability,
  far less machinery; continuity stays durable via `agent_sessions`.
- **Fresh sandbox every turn (no persistence)** — rejected: loses the workspace
  every turn, so the model cannot build on prior file work.

## Consequences

- Removed: the snapshot barrier (`snapshot-barrier.ts` and its call in
  `RunLoop.finish()`), the dirty flag (its only consumer was the barrier), the
  `dirty_uncheckpointed` state and its recovery, the restore-from-snapshot path,
  and snapshot rotation/retention. `WORKER_SNAPSHOT_RETENTION_MS` is removed.
- Schema: drop `latest_snapshot_id`, `previous_snapshot_id`, and
  `workspace_checkpoint_status` from `conversation_runtime`, plus the runtime
  helpers that write them, via a migration (no prod data on these columns).
- **No idle reaper** — not even a follow-up. Keep-forever is safe on the current
  tier per the verified limits. A one-line note remains: if E2B ever introduces a
  paused-sandbox count or storage limit, an idle reaper on the existing cleanup
  loop is the mitigation.
- The cleanup loop keeps only two sweeps, both cost-independent: **orphaned**
  sandboxes (recorded via `recordOrphanSandboxTx` whenever a tainted/failed
  sandbox is replaced, so a superseded sandbox never leaks) and
  **deleted-conversation** sandboxes (privacy/correctness — the user deleted the
  conversation; its sandbox holding their files must be killed).
- A tainted sandbox (command cleanup unproven) is never reused: provisioning
  goes straight to a fresh sandbox and orphan-records the tainted one.
- Amends ADR-0005: session-transcript cleanup rode on "the same cleanup that owns
  snapshots"; snapshots are gone, but that cleanup loop remains (for orphans and
  deleted conversations), so transcript cleanup still rides on it.
- The design doc's snapshot sections (Task 4.1 durability model, Task 5.3, the
  Milestone 8 snapshot-retention sweep, and the smoke-suite "survives sandbox
  pause/reconnect" step, which now exercises paused-sandbox reconnect rather than
  snapshot restore) are superseded by this ADR.
