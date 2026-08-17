# Agent worker runtime

Use this guide for changes under `apps/agent-worker`, shared Run-serving behavior, Claude Agent SDK integration, E2B provisioning, Searchable document tools, or artifact publication.

## Conversation control plane and Run serving

`src/run-loop.ts` owns the Fargate-only control plane: global queued expiration and Reclamation, Conversation Claim, bounded snapshot ordering, Run start, and unconditional release. One supervisor slot is held for an entire Conversation drain. A tick renews unserved Claim windows and prompts attached Run heartbeats; timer ticks remain authoritative even when the optional `RunDoorbell` provides low-latency pickup.

Each Claim's snapshot Runs execute one at a time in submission order through an injected `RunProcessor`. A lost Ownership lease halts the drain without release. Graceful shutdown aborts the active Run, stops serving the remaining snapshot, and releases the Conversation so unstarted Runs remain queued and become eligible for the next Claim.

`src/run-serving.ts` owns an already-running Run's lease renewal, durable interruption observation, Live Stream production and degradation, processor supervision, artifact publication, and terminalization. It contains no Claim, ordering, expiration, Reclamation, or release behavior and returns a typed terminal, Ownership-loss, or shutdown result. See [ADR-0023](../adr/0023-share-run-serving-without-sharing-runtime-control-loops.md).

## SDK stream and tools

`src/sdk/run-processor.ts` starts one Claude Agent SDK query for a Run started under the Conversation's Claim. `src/sdk/agent-stream.ts` consumes the stream under supervision:

- Append canonical model content as sequence-numbered Run events only while the Run is `running`.
- Commit each completed Assistant message and its validated `ui_payload` events atomically, then publish `mymemo.generative_ui` only after commit.
- Persist correlated, MyMemo-identified Tool lifecycle events before their live AG-UI projections.
- Ignore content after `interrupt_requested`.
- Let SDK failures terminalize as `error`.
- Interrupt the query on durable interruption, Ownership loss, or runtime shutdown.

`src/sdk/run-tools.ts` binds the file, Bash, Searchable document, and display-only `PresentUI` catalog tools. Exclude `PresentUI` itself from Tool projection. Built-in tools are disabled; the executor allowlist is fail-closed.

## Conversation continuity

The worker mirrors the SDK transcript to Postgres through `src/sdk/session-store.ts` under a deterministic per-Conversation query working directory. The bound `SessionStore` supplies evidence for the successfully mirrored main Agent session.

A qualifying `done` or `interrupted` terminal transaction publishes `conversation_runtime.agent_session_id` atomically with the Outcome. A `mirror_error` stops Tool and E2B work; a still-running Run ends as `error`, while an already-committed interruption remains `interrupted`. That turn must not establish or advance the resume pointer. Conversation deletion removes its transcripts during cleanup. See [ADR-0005](../adr/0005-conversation-continuity-postgres-session-store.md).

## Query and sandbox startup

`src/sdk/start-run-query.ts` must:

- Read `run_started` through shared `loadRunStartedTx`, deriving a plain-string prompt and the frozen Scope for Searchable documents with fail-closed parsing.
- Ensure the runtime row idempotently and connect to or create the E2B Workspace.
- Persist a fresh sandbox pointer through the live Ownership fence. If the fence rejects it, kill the escaped sandbox; if that kill fails, record the orphan. Record every replaced sandbox pointer as an orphan.
- Keep the sandbox awake with the per-Run monotonic renewal timer. Renewal failure aborts the linked controller so the Run ends `error`, never `done`.
- Disable built-ins and settings sources, use `dontAsk` with the executor allowlist, provide the static system prompt, and add an ephemeral `CLAUDE_CONFIG_DIR` without exposing worker secrets to E2B.
- Use the boot-verified pinned Claude CLI path.

`src/index.ts` resolves and verifies the SDK CLI before claiming work, creates the per-Conversation Fargate query directory, and wires the real SDK processor. When a Run ends with an `error` Outcome, persist only a generic client-facing message and keep internal details in trusted-worker logs.

## AgentCore dispatch publication

`src/agentcore-dispatch/publisher-loop.ts` owns the worker-embedded publisher from ADR-0026. Every worker replica ticks on the configured interval, but one tick-scoped session advisory lock admits only one publisher. The holder checks the fail-closed SSM gate, claims a bounded outbox batch, sends strict envelopes to SQS, and confirms successful sends before releasing the lock. A losing replica records `lost_lock`; failures stay isolated to the loop; shutdown waits for an in-flight tick to release its database connection.

The loop emits CloudWatch embedded metrics for lost locks, errors, and the oldest unpublished admission age. It does not publish from Run admission and does not delete outbox audit rows.

## Searchable documents and Downloadable artifacts

The scoped Searchable document client exposes `ListDocuments`, `SearchDocuments`, and `LoadDocuments`. Loading writes scope-checked, byte-capped Searchable document content into `.mymemo/docs/` and returns only `{ documentId, title, path, truncated }`; Searchable document bodies must not enter Run events. See [ADR-0004](../adr/0004-documents-as-files-conversation-cache.md).

For a Run with a `done` Outcome, compare start and end manifests under `/home/user/artifacts`, ledger each new private object key before upload, upload binary-safe content, and commit changed current-artifact metadata atomically with `run_done`. See [ADR-0011](../adr/0011-publish-downloadable-artifacts-on-success.md).
