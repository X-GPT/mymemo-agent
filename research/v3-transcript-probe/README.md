# Transcript SessionStore probe (#709, 2026-09-03)

Throwaway kit that answered the open unknowns of the S3 SessionStore research (#703) on the real pinned CLI (`@anthropic-ai/claude-agent-sdk@0.3.251`, CLI 2.1.251) with a fake Anthropic Messages server and no model key.

Run from `apps/in-vm-server/` (so the SDK resolves): `bun run <this dir>/probe.ts <scenario>` with `PROBE_APPEND_DELAY`, `PROBE_FLUSH`, `PROBE_LOAD=mem|null|throw`. Logs `q1.log` … `q4-throw.log` are the runs cited in the ticket resolution.

Findings: pre-minted `Options.sessionId` composes with `sessionStore`; `CLAUDE_CODE_PROJECT_DIR_NAME` + `CLAUDE_CONFIG_DIR` pin `projectKey` on the real CLI; the SDK awaits the transcript flush before yielding `result` and before the iterator ends; batched mode = two appends per Turn; a `null` load makes the CLI fail with "No conversation found with session ID"; a throwing `load` rejects `query()` before spawn.
