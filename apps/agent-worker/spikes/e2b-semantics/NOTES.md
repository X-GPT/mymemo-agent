# Findings — E2B semantics gate (Task 4.1)

Live run 2026-07-05 against real E2B, template `base`, SDK `e2b@2.19.0`
(satisfies the pinned `^2.14.0`). Full log: one run of all proofs + one re-run
of p6 after a cleanup-command bug (pkill matched its own shell wrapper; fixed
with `pkill -x`). Verdict per proof:

| id | proof | verdict |
|----|-------|---------|
| p1 | pause-on-timeout preserves files | **PASS** |
| p2 | paused sandbox reconnect/resume | **PASS** |
| p3 | active timeout can be extended | **PASS** |
| p4 | snapshot returns reusable checkpoint id | **PASS** |
| p5 | fresh sandbox restores from checkpoint | **PASS** |
| p6 | timeout/cancel cleanup covers descendants | **NO — wrapper required** |
| p7 | paused sandbox vs snapshot distinct at rest | **PASS** |

## What the pinned SDK actually provides

- **Lifecycle shape (design doc sketch was wrong):** the real 2.19 option is
  `lifecycle: { onTimeout: 'pause' | 'kill', autoResume?: boolean }` — a flat
  enum, not the guessed `{ onTimeout: { action, keepMemory } }`. There is **no
  `keepMemory` option** in the JS SDK 2.19 surface: pause always saves
  filesystem + memory (docs: pause ≈ 4 s/GiB RAM, resume ≈ 1 s). The design's
  "pause mode -> filesystem-only by default" is not available.
- **p1:** sandbox created with `timeoutMs: 20_000, lifecycle: { onTimeout: 'pause' }`
  was observed `paused` ~1 s after the deadline (20.9 s from create). File
  written before pause was intact after `Sandbox.connect`.
- **p2:** explicit `sandbox.pause()` → state `paused`; `Sandbox.connect(id)`
  auto-resumed in **256 ms**, state `running`, file intact. Connect is the
  resume primitive — there is no separate `resume()` in the JS SDK.
- **p3:** `setTimeout(ms)` is **absolute** — it extended 60 s → 300 s and also
  *reduced* when given a smaller value. `Sandbox.connect(id, { timeoutMs })`
  only extends, never shrinks (verified: connect with 30 s did not shrink a
  300 s deadline). Worker renewal loop: `setTimeout` with monotonically
  computed deadlines, or connect-extend.
- **p4:** `sandbox.createSnapshot()` → `{ snapshotId: "<templateId>:default" }`
  in **0.4 s** (tiny base sandbox). **The source sandbox was `running`
  afterward** — any pause during snapshotting is transient and self-resolving;
  a checkpoint does not leave the sandbox paused. Keep the worker-side barrier
  (no snapshot while a managed command runs) anyway: the transient pause would
  suspend in-flight commands.
- **p5:** `Sandbox.create(snapshotId)` after killing the source produced a new
  sandboxId with the file intact — the snapshot is durable beyond the source
  sandbox's lifetime.
- **p6 (the design-changing one):** a foreground `bash -c 'sleep 300 & wait'`
  killed by `timeoutMs` raised `TimeoutError [deadline_exceeded]` but the
  backgrounded `sleep 300` **survived, reparented to init** (`ppid 1`).
  Explicit `commands.kill(pid)` of a background command likewise killed only
  the managed parent; its descendant survived. **Neither timeout nor kill
  covers the process tree — the sandbox-side process-group wrapper is required
  before enabling Bash** (create an owned session/process group per command,
  kill the group on timeout/cancel/stale-run recovery).
- **p7:** a paused sandbox and a snapshot are distinct objects with distinct
  lifetimes: the paused sandbox appears in `Sandbox.list({ state: ['paused'] })`,
  snapshots in `Sandbox.listSnapshots({ sandboxId })`; the snapshot survived
  `Sandbox.kill()` of its source; `Sandbox.deleteSnapshot(id)` → `true`.

## Cost model (docs, not script)

Per E2B billing docs and pricing pages: compute is billed per second **only
while a sandbox is running** — billing stops on pause/kill/timeout. Paused
state (filesystem + memory) is retained **indefinitely** with no auto-TTL, and
the saved state accrues storage until explicitly killed; snapshots likewise
persist until `deleteSnapshot`. E2B publishes no flat $/GB-month rate in the
docs (they point at the pricing calculator), so the at-rest cost of a paused
sandbox vs a snapshot is the same *kind* of cost (stored bytes), differing
mainly in that pause includes memory state and a snapshot is filesystem-image
shaped.

**Retention decision (Task 4.1 acceptance):** bounded idle lifetime with
snapshot restore. Paused sandboxes accumulate storage silently and forever;
"live-forever" means unbounded per-conversation storage. Policy: keep the
paused sandbox as the normal resume path while a conversation is warm; a
reaper ensures a fresh snapshot exists, kills paused sandboxes idle past a
configurable window (suggest days, not minutes — resume-from-paused is ~250 ms
and snapshot-restore is a full sandbox create), and retains only the latest
snapshot per conversation (`deleteSnapshot` the superseded one).

Sources: e2b.dev/docs/sandbox/persistence, e2b.dev/docs/billing,
e2b.dev/pricing.

## Status

Findings were folded into the worker implementation and ADRs. This spike
directory can be deleted once Task 4.2+ consume the findings.
