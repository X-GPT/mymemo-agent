# PROTOTYPE — Conversation-ownership Claim (ADR-0015)

**Throwaway. Delete this directory once `/to-spec` has consumed the answers below.**

## The question

ADR-0015 moves execution ownership from the Run to the Conversation, fenced by a
per-Conversation epoch. The architecture is settled; three Postgres behaviours it
rests on had never been executed. Each could change the Claim statement's *form*;
none can change the decision.

1. **Is `FOR UPDATE OF c SKIP LOCKED` legal in the Claim's join shape, and does it
   plan sanely?** And separately — do two concurrent claimants actually *skip*
   each other rather than block or double-claim?
2. **Snapshot integrity under concurrent admission.** Admission and Claim both
   take `conversations` first, so a Run should be either inside the snapshot or
   deferred to the next Claim. Never lost, never double-served.
3. **Fence-read cost.** ADR-0015 puts a non-locking `conversations` probe on every
   fenced write (~15–20 per turn) against ~3 writes per Claim. Do the fence reads
   and the Claim/release writes interfere?

## Running it

Everything runs against a **scratch Postgres container**, not the compose stack —
the real migrations are applied to it, then the ADR-0015 schema delta on top, so
the statements run against the real table shapes, FKs and indexes.

```bash
bun run --cwd packages/agent-db proto:up
```

Then, from `packages/agent-db`:

| Command | Answers |
|---|---|
| `bun run proto:tui` | The hand-driven interleavings — §3.1 contention, the epoch fence |
| `bun run proto:explain` | §3.1 legality + plans + head-of-queue skew |
| `bun run proto:race` | §3.2 snapshot integrity (add `--chaos` for lapsing leases) |
| `bun run proto:bench` | §3.3 fence-read cost A/B |
| `bun run proto:down` | Remove the scratch container |

`ownership.ts` is the portable half — the exact SQL under test, pure, no I/O. The
TUI and the two harnesses are the disposable shell around it.

## Answers

Measured on **PostgreSQL 16.14** in Docker on macOS. Absolute latencies are not
production numbers; the A/B ratios and the invariant results are the findings.
Production's server version was not checked — worth confirming it is also 16.x.

### 3.1 — Legal, and it plans better than expected. Use the join shape.

`FOR UPDATE OF c SKIP LOCKED` is accepted and executes. At 2000 conversations ×
3 queued Runs the plan is:

```
Limit -> LockRows -> Nested Loop
                       -> Index Scan using runs_queue_claim_idx on runs r
                       -> Memoize -> Index Scan conversations_pkey on c
```

**There is no Sort.** `runs_queue_claim_idx` — which already exists in production
(`(created_at) WHERE status = 'queued'`) — delivers `runs` in `created_at` order,
so the planner elides it. That matters for more than cost: LockRows sits directly
under Limit, so rows are locked one at a time **in queue order**, and SKIP LOCKED
skips in queue order rather than scan order. 7 buffers, 0.074 ms.

The two alternatives are worse and neither is needed:

| shape | 2000×3 | verdict |
|---|---|---|
| `join` (ADR-0015's sketch) | 7 buffers, 0.074 ms | **use this** |
| `select_then_update` | identical candidate plan | fallback only; one extra round trip |
| `exists_min` (no join) | 7697 buffers, 19.7 ms | reject — Sort + per-row SubPlan aggregate |

**Contention: claimants skip, they do not block or double-claim.** Driven by hand
in the TUI, holding real transactions open:

- an **uncommitted admission** holding `conversations FOR UPDATE` makes that
  Conversation invisible to a Claim — the claimant returns empty rather than
  waiting;
- a **held claim transaction** is likewise skipped by the other worker.

Under load (4 admitters hammering one Conversation with zero think time — far
past anything realistic) **4–6 % of claim attempts skipped a locked row**. The
claimant just retries on the next tick, so this is latency, not starvation.

**New finding — head-of-queue skew.** Because the scan walks `runs` in *global*
`created_at` order and probes `conversations` per row, every queued Run belonging
to an already-owned Conversation is a row the candidate scan walks past:

| queued Runs on the owned Conversation | rows walked | time |
|---|---|---|
| 1 | 2 | 0.13 ms |
| 100 | 101 | 1.29 ms |
| 1000 | 1001 | 0.70 ms |
| 5000 | 5001 | 3.44 ms |

So claim cost is **O(queued Runs ahead of the first claimable Conversation)** —
bounded by (admission depth bound × concurrently-owned Conversations). The
admission depth bound is therefore load-bearing for *claim cost*, not only for
drain length. At a small bound this is free; if the bound is ever raised, every
idle worker pays this on every tick.

### 3.2 — Snapshot integrity holds. Adversarially confirmed.

`race.ts`, 4 admitters vs 4 claimants on a single Conversation, ~700 Runs per
5 s run. All shapes, both snapshot placements:

```
PASS  never double-served (no Run started twice under the fence)
PASS  never double-terminalized
PASS  never lost (every admitted Run reached some snapshot)
PASS  each Run in exactly one snapshot
PASS  every admitted Run reached done
```

Under `--chaos` (lease 60 ms, so leases lapse mid-drain and a second worker
re-Claims while the first is still serving): **71 fence rejections, 0
double-starts, 0 double-terminalizations, 0 lost.** 68 Runs were left stranded in
`running` by workers whose lease lapsed — that is Reclamation's job, not the
snapshot's, and it is the expected shape.

**The sharpest result — what the same-transaction snapshot is actually for.**
Counting Runs whose admission committed *after* their Claim committed yet still
appeared in that Claim's snapshot, with a 100 ms artificial gap inserted to widen
the window:

| snapshot placement | Runs served after their own Claim | all safety checks |
|---|---|---|
| same transaction (ADR-0015) | **0** | pass |
| after the Claim commits | **44** | pass |

Both are *safe*. The same-transaction snapshot is load-bearing for the **bound**,
not for correctness — exactly the property ADR-0015 cites it for ("bounds drain
length by the admission depth bound with no second constant"). The spec must say
"same transaction" **and say why**, or a later refactor that splits them will look
harmless and quietly unbound the drain.

**Also confirmed: unconditional release is safe.** A worker whose epoch has been
superseded gets `0 rows` from `WHERE conversation_id = $c AND epoch = $epoch` — it
cannot steal the Conversation back from its successor.

### 3.3 — The probe costs a few ms per turn. It does not interfere with Claim/release.

A/B on one variable: identical work in both arms, only the fenced append's
predicate differs (`EXISTS` probe on `conversations` vs today's
`runs.locked_by`/`locked_until`).

| workers | fence p50 epoch | fence p50 lease | claim p50 epoch | claim p50 lease |
|---|---|---|---|---|
| 1 | 2.27 ms | 2.00 ms | 1.91 ms | 1.85 ms |
| 8 | 3.62 ms | 3.18 ms | 2.42 ms | 2.30 ms |
| 32 | 8.32 ms | 6.75 ms | 3.35 ms | 3.51 ms |

- The probe costs a **consistent ~13–25 % on the fenced-write statement**, holding
  in both arm orders. At 18 writes per turn that is **~5 ms/turn at low
  concurrency, ~30 ms/turn at 32 concurrent workers** — against a turn measured in
  seconds to minutes.
- **Claim and release latency are unaffected.** An early run showed claim p95 of
  62 ms vs 11 ms and looked like a real effect; re-running with the arm order
  flipped showed the anomaly followed *arm position*, not the fence. It was a
  warm-up artifact. §3.3's actual worry — fence reads interfering with the
  ownership writes — did not reproduce.
- Adding 6 background admitters writing the *same* `conversations` rows (the
  "hottest row" concern) did not change the picture.
- Throughput is ~20 % lower in the epoch arm at 32 workers, fully accounted for by
  the per-append cost (appends are 82 % of statements).

## Verdict

**Nothing here contradicts ADR-0015.** The Claim keeps the form the ADR sketches,
and it wants no new index — `runs_queue_claim_idx` already exists.

Two things the spec should carry that the ADR does not currently say:

1. The snapshot **must** share the Claim's transaction, and the reason is the
   drain-length bound, not safety. Both placements are safe, so the constraint is
   invisible to a reviewer who is only checking correctness.
2. Claim cost is **O(queued Runs ahead of the first claimable Conversation)**, so
   the admission depth bound also bounds claim cost. Raising it later is not free.

## Cleanup

```bash
bun run --cwd packages/agent-db proto:down
rm -rf packages/agent-db/prototype-conversation-ownership
```

…and drop the four `proto:*` scripts from `packages/agent-db/package.json`.
