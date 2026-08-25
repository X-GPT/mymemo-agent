# Trusted Run serving

Use this guide for changes under `apps/agentcore-runtime`, Run-serving behavior, Claude Agent SDK integration, E2B provisioning, Searchable document tools, or artifact publication.

`apps/agentcore-runtime` is the sole production execution runtime and owns its
Run-serving implementation directly. `packages/agent-worker` now contains only
the maintenance implementation composed by `apps/agent-maintenance`; it has no
Run-serving path.

## Exact acquisition and Run serving

AgentCore consumes a strict Dispatch envelope and atomically acquires exactly
that queued Run through `acquireAgentCoreDispatchTx`. Acquisition starts the Run
and establishes Conversation Ownership in one transaction. Runtime concurrency
is one invocation; there is no snapshot drain or alternative runtime path.

`packages/agent-worker/src/maintenance-runner.ts` implements queued-Run
expiration, fenced Reclamation, and asynchronous resource cleanup. Only the
independently healthy `apps/agent-maintenance` service composes it in production.

`src/run-serving.ts` owns an already-running Run's lease renewal, durable interruption observation, Live Stream production and degradation, processor supervision, artifact publication, and terminalization. It contains no Claim, ordering, expiration, Reclamation, or release behavior and returns a typed terminal, Ownership-loss, or shutdown result. See [ADR-0023](../adr/0023-share-run-serving-without-sharing-runtime-control-loops.md).

## SDK stream and tools

`src/sdk/run-processor.ts` starts one Claude Agent SDK query for an acquired Run. `src/sdk/agent-stream.ts` consumes the stream under supervision:

- Append canonical model content as sequence-numbered Run events only while the Run is `running`.
- Commit each completed Assistant message and its validated `ui_payload` events atomically, then publish `mymemo.generative_ui` only after commit.
- Persist correlated, MyMemo-identified Tool lifecycle events before their live AG-UI projections.
- Ignore content after `interrupt_requested`.
- Let SDK failures terminalize as `error`.
- Interrupt the query on durable interruption, Ownership loss, or runtime shutdown.

`src/sdk/run-tools.ts` binds the file, Bash, Searchable document, and display-only `PresentUI` catalog tools. Exclude `PresentUI` itself from Tool projection. Built-in tools are disabled; the executor allowlist is fail-closed.

Use `Bash` with `rg --files`, `find`, or `ls` for workspace filename discovery. `Grep` remains the structured, bounded content-search tool. `Glob` is no longer executable; its shared event name remains only for replaying historical Run events. See [ADR-0030](../adr/0030-use-bash-for-workspace-file-discovery.md).

## Conversation continuity

The Runtime mirrors the SDK transcript to Postgres through `src/sdk/session-store.ts` under a deterministic per-Conversation query working directory. The bound `SessionStore` supplies evidence for the successfully mirrored main Agent session.

A qualifying `done` or `interrupted` terminal transaction publishes `conversation_runtime.agent_session_id` atomically with the Outcome. A `mirror_error` stops Tool and E2B work; a still-running Run ends as `error`, while an already-committed interruption remains `interrupted`. That turn must not establish or advance the resume pointer. Conversation deletion removes its transcripts during cleanup. See [ADR-0005](../adr/0005-conversation-continuity-postgres-session-store.md).

## Query and sandbox startup

The non-production `agent-query-runtime` reuses the same E2B provisioner,
renewal loop, and bounded file tools for synchronous Agent queries. `Bash`
remains excluded because this path has no durable Run/audit identity.
SessionStore failure aborts Workspace tools and interrupts Claude before a
terminal result can escape. Before Claude starts and periodically during Claude
and Tool work, the Runtime verifies the matching live Conversation response
epoch/deadline. Database errors never extend its last confirmed deadline.
SessionStore and Workspace/runtime-state mutations carry the same fence;
same-epoch duplicate invocations are suppressed, while a newer epoch must stop
and settle prior local work before replacement. The shared Chat API may mount
the staged route, but production must not configure this Runtime or switch
callers and execution authority before the hard swap.

`src/sdk/start-run-query.ts` must:

- Read `run_started` through shared `loadRunStartedTx`, deriving a plain-string prompt and the frozen Scope for Searchable documents with fail-closed parsing.
- Ensure the runtime row idempotently and connect to or create the E2B Workspace.
- Persist a fresh sandbox pointer through the live Ownership fence. If the fence rejects it, kill the escaped sandbox; if that kill fails, record the orphan. Record every replaced sandbox pointer as an orphan.
- Keep the sandbox awake with the per-Run monotonic renewal timer. Renewal failure aborts the linked controller so the Run ends `error`, never `done`.
- Disable built-ins and settings sources, use `dontAsk` with the executor allowlist, provide the static system prompt, and add an ephemeral `CLAUDE_CONFIG_DIR` without exposing Runtime secrets to E2B.
- Use the boot-verified pinned Claude CLI path.

`apps/agentcore-runtime/src/production.ts` resolves and verifies the SDK CLI
before accepting invocations and wires the real SDK processor. When a Run ends
with an `error` Outcome, persist only a generic client-facing message and keep
internal details in trusted Runtime logs.

## Related AgentCore dispatch publisher

`apps/agentcore-dispatch-publisher/src/main.ts` is the dedicated app entrypoint
for the one publisher ECS task from ADR-0027. The publisher task checks the
fail-closed SSM gate, claims a bounded outbox batch, sends strict envelopes to
SQS, and confirms successful sends. Its tick-scoped session advisory lock only
excludes old/new task overlap during a rolling deployment.

`SIGINT` or `SIGTERM` aborts the sleep after a tick; shutdown waits for an active tick to release its database connection and then closes the pool. The loop emits CloudWatch embedded metrics for normal `lock_not_acquired` contention, errors, and the oldest unpublished admission age. It does not publish from Run admission and does not delete outbox audit rows.

## Searchable documents and Downloadable artifacts

The scoped Searchable document client exposes `ListDocuments`, `SearchDocuments`, and `LoadDocuments`. Loading writes scope-checked, byte-capped Searchable document content into `.mymemo/docs/` and returns only `{ documentId, title, path, truncated }`; Searchable document bodies must not enter Run events. See [ADR-0004](../adr/0004-documents-as-files-conversation-cache.md).

For a Run with a `done` Outcome, compare start and end manifests under `/home/user/artifacts`, ledger each new private object key before upload, upload binary-safe content, and commit changed current-artifact metadata atomically with `run_done`. See [ADR-0011](../adr/0011-publish-downloadable-artifacts-on-success.md).
