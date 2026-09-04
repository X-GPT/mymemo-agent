# Transcript SessionStore probe (#709, 2026-09-03)

Throwaway kit that answered the open unknowns of the S3 SessionStore research (#703) on the real pinned CLI (`@anthropic-ai/claude-agent-sdk@0.3.251`, CLI 2.1.251) with a fake Anthropic Messages server and no model key.

Run from `apps/in-vm-server/` (so the SDK resolves): `bun run <this dir>/probe.ts <scenario>` with `PROBE_APPEND_DELAY`, `PROBE_FLUSH`, `PROBE_LOAD=mem|null|throw`. Logs `q1.log` … `q4-throw.log` are the runs cited in the ticket resolution.

Findings: pre-minted `Options.sessionId` composes with `sessionStore`; `CLAUDE_CODE_PROJECT_DIR_NAME` + `CLAUDE_CONFIG_DIR` pin `projectKey` on the real CLI; the SDK awaits the transcript flush before yielding `result` and before the iterator ends; batched mode = two appends per Turn; a `null` load makes the CLI fail with "No conversation found with session ID"; a throwing `load` rejects `query()` before spawn.

## probe2 — resume from a copied local transcript, no SessionStore (2026-09-04)

Decision evidence for abandoning the SessionStore ([#709 amendment](https://github.com/X-GPT/mymemo-agent/issues/709)). `probe2/probe2.ts` imports `sdk.mjs` by absolute path from `apps/in-vm-server/node_modules` so it really runs the pinned SDK 0.3.251 / CLI 2.1.251 (`run4-pinned.log` is authoritative; `run1..3.log` ran Bun's cached 0.3.260 with identical outcomes).

Findings: with no `sessionStore`, copying only `projects/<dir>/<sessionId>.jsonl` into an empty `CLAUDE_CONFIG_DIR` on a different cwd resumes the session (fake model saw 2 → 5 → 8 messages); an empty dir yields `No conversation found with session ID`; the single JSONL suffices; JSONL 2721 / 6148 / 9506 B after Turns 1–3; **resume by id is cwd-independent**, so `CLAUDE_CODE_PROJECT_DIR_NAME` only fixes the write path and is not needed.

**Caveat on `probe/`**: a script in the scratchpad with a bare `import '@anthropic-ai/claude-agent-sdk'` resolves Bun's global cache (0.3.259/260 at the time), not the app's pinned copy — the `probe/` runs were on CLI 2.1.259. Their still-relevant facts (pre-minted `Options.sessionId`, the missing-transcript error) were re-verified on 2.1.251 by probe2.
