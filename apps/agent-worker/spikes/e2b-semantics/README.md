# SPIKE: E2B semantics gate (Task 4.1) — THROWAWAY CODE

**Question:** does the pinned E2B SDK (`e2b ^2.14.0`, resolved 2.19.0) actually
provide the seven behaviors the split-runtime implementation depends
on for user-work durability, or does the design need the sandbox-side command
wrapper / a separate durable workspace store?

This is an integration spike against **real E2B**, not a state-model prototype:
the artifact is a sequential proof runner, not an interactive TUI, because the
thing under test is a live external API, not our own logic.

## Run

```bash
E2B_API_KEY=... bun run spike:e2b            # all proofs (from apps/agent-worker)
E2B_API_KEY=... bun run spike:e2b p2 p6      # subset by id
E2B_API_KEY=... bun run spike:e2b cleanup    # kill leftover spike sandboxes/snapshots
```

Proof `p1` (pause-on-timeout) idles a sandbox past its timeout and polls, so a
full run takes a few minutes. Every sandbox/snapshot the spike creates is
tagged with metadata `spike=e2b-semantics` and killed/deleted on the way out;
`cleanup` sweeps anything a crashed run left behind.

## The seven proofs

| id | proof |
|----|-------|
| p1 | pause-on-timeout preserves files |
| p2 | paused sandbox can reconnect/resume |
| p3 | active timeout can be extended |
| p4 | snapshot creation returns a reusable checkpoint id |
| p5 | fresh sandbox restores from checkpoint (and snapshot survives source kill) |
| p6 | command timeout/cancel cleanup handles descendants, or a wrapper is needed |
| p7 | paused sandbox vs snapshot are distinct objects at rest (cost model evidence) |

p7's dollar figures are a docs question, not a script question — the script
only proves object distinctness; pricing goes in NOTES.md.

## When done

Findings land in `NOTES.md` here and back in
the relevant ADR and implementation notes. Then this
directory gets deleted — do not import anything from it.
