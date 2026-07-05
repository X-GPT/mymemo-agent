# Hard-swap to the split runtime; no coexistence flag

Status: accepted

The daemon-based prototype path and the split-runtime path enforce "one
active turn per conversation" with different authorities — the
`sandbox_leases` CAS lease versus the `runs` partial unique index. A
deployment where both paths are reachable (e.g. behind a runtime-mode flag)
has no single authority for that invariant: two turns could run concurrently
on one conversation, each legal under its own authority. The cutover is
therefore a hard swap of the `user.message` handler (Task 2.1), not a flag.
This is safe because nothing deployed exercises the prototype path: Terraform
ships only `chat-api` and `agent-worker`, the Statsig gate defaults closed,
and the gateway/daemon exist only in the local compose harness.

## Consequences

- There is a short local-demo gap between the swap and Milestone 3, when the
  synthetic worker restores a working end-to-end SSE path. The compose/e2e
  harness is rewritten against split-runtime semantics at Milestone 3, not
  Milestone 7.
- Superseded components are deleted eagerly, keyed to the milestone that
  replaces them: chat-api's `sandbox-orchestration`/`sandbox-agent` features
  and llm-token minting die with the Task 2.1 swap; `apps/gateway`,
  `apps/sandbox-daemon`, `apps/mymemo-docs`, `packages/llm-token`, and the
  compose `gateway`/`sandbox` services die when Milestone 7 passes the full
  local harness; `sandbox_leases` is dropped in the same migration that
  creates `conversation_runtime` (Task 4.2).
