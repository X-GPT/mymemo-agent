# System architecture

Use this guide when a change crosses service or package boundaries. For canonical terminology, read [the domain guide](domain.md) and the relevant [ADRs](../adr/).

## Components

| Component | Responsibility |
| --- | --- |
| `apps/chat-api` | Creates and manages Conversations, admits Runs idempotently, attaches clients to Live Streams, projects permanent history, and lists or signs current Downloadable artifacts. |
| `apps/agent-worker` | Trusted Fargate execution runtime. Claims Conversations, serves their Runs in submission order, calls the Claude Agent SDK through OpenRouter, accesses scoped documents, delegates untrusted file and shell work to E2B, and publishes artifacts. |
| `apps/agentcore-canary-dispatch` | Production-shaped AgentCore dispatch boundary: transactional outbox publication, strict content-free SQS envelopes, exact acquisition, manual replay, and partial-batch acknowledgement. Its boundary ends after the exact Run reaches `running`. |
| `apps/agentcore-canary-runtime` | Linux ARM64 AgentCore Runtime that serves one acquired canary Run and delegates the already-running Run to shared Run-serving behavior. It does not run Fargate Claim, drain, expiration, Reclamation, or cleanup loops. |
| `packages/agent-db` | Shared writable `mymemo_agent` data layer: schema, migrations, Run and Conversation Ownership transactions, runtime pointers, session transcripts, artifact metadata, and PGlite test support. |
| `packages/live-text` | Redis configuration, event validation, and producer-buffered in-memory/Redis Live Stream relay implementations. |

The removed `gateway`, `sandbox-daemon`, `mymemo-docs`, and `@mymemo/llm-token` services belong to the superseded prototype path and are not fallbacks. See [ADR-0002](../adr/0002-hard-swap-no-coexistence-flag.md).

## Execution and persistence invariants

### Conversation control plane

A Fargate worker Claims a Conversation and drains the Runs present in that Claim's snapshot one at a time in submission order. `apps/agent-worker/src/run-loop.ts` owns Claim, snapshot ordering, Run start, release, and heartbeat cadence. `apps/agent-worker/src/run-serving.ts` owns an already-running Run's lease renewal, interruption observation, processor supervision, Live Stream, artifact publication, and terminalization. See [ADR-0015](../adr/0015-conversation-level-ownership-with-epoch.md) and [ADR-0023](../adr/0023-share-run-serving-without-sharing-runtime-control-loops.md).

Every execution mutation is fenced by the live Conversation Ownership epoch and lease. Reclamation terminalizes started Runs after a lapsed lease, leaves unstarted queued Runs for the next Claim, taints the Workspace when cleanup is unproven, and clears Ownership.

### Live and permanent output

The worker keeps each active Run's standard AG-UI Live Stream backlog in memory and relays events over Redis pub/sub. Redis stores no stream content. Permanent Assistant messages, Tool activity, UI payloads, and Outcomes commit to Postgres before their matching completion events are published. Relay failure degrades live delivery without changing durable Run execution. See [ADR-0014](../adr/0014-producer-buffered-live-stream-over-pubsub.md).

### Workspace and continuity

A successful turn terminalizes as `done`; there is no end-of-turn checkpoint. The paused E2B sandbox is the persistent Workspace between turns. See [ADR-0007](../adr/0007-drop-snapshots-paused-sandbox-persistence.md).

The Claude SDK transcript is mirrored through the worker `SessionStore` into Postgres under a deterministic per-Conversation query working directory. A qualifying `done` or `interrupted` terminal transaction publishes the successfully mirrored main-session pointer atomically with the Outcome. A mirror error fails the Run and does not establish or advance that pointer. See [ADR-0005](../adr/0005-conversation-continuity-postgres-session-store.md).

### Documents and artifacts

The worker exposes scoped document inventory, passage search, and document loading. Loaded document bodies are written only to `.mymemo/docs/` in the sandbox; model-facing results contain metadata, not document bodies. See [ADR-0004](../adr/0004-documents-as-files-conversation-cache.md).

On a successful turn, the worker compares the start and end manifests under `/home/user/artifacts`, ledgers new private object keys before upload, and commits current-artifact metadata atomically with `run_done`. See [ADR-0011](../adr/0011-publish-downloadable-artifacts-on-success.md).

## Module map

| Path | Purpose |
| --- | --- |
| `apps/chat-api/src/features/conversations/` | Conversation resources, strict AG-UI Run admission, relay-backed SSE/reconnect, and interruption |
| `apps/chat-api/src/features/conversation-history/` | Owner-scoped permanent history over canonical Run events |
| `apps/chat-api/src/features/artifacts/` | Current-artifact listing and five-minute S3 download signing |
| `apps/chat-api/src/features/conversation-store/` | Durable Conversation registry and frozen Scope |
| `apps/chat-api/src/features/exposure-gate/` | Statsig and break-glass implementations of the new-work gate |
| `apps/chat-api/src/features/run-store/` | Run admission, owner-scoped Run reads, and durable interruption |
| `apps/chat-api/src/db/` | Thin bindings to `@mymemo/agent-db` and the shared migration runner |
| `apps/agent-worker/src/run-loop.ts` | Fargate-only Claim, ordering, expiration, Reclamation, and release control plane |
| `apps/agent-worker/src/run-serving.ts` | Shared serving behavior for an already-running Run |
| `apps/agent-worker/src/sdk/` | SDK query wiring, transcript mirroring, tools, and AG-UI event projection |
| `apps/agent-worker/src/artifacts/` | Successful-Run artifact discovery, upload, and publication |
| `packages/agent-db/src/conversation-ownership.ts` | Claim protocol and live Ownership fence |
| `packages/agent-db/src/run-store.ts` | Fenced Run state and Run-event transactions |
| `packages/agent-db/src/runtime-store.ts` | Fenced sandbox, taint, and Agent-session pointers plus orphan ledger |
| `packages/agent-db/src/session-store.ts` | Worker-fenced SDK transcript mutation and administrative deletion |
| `packages/agent-db/src/artifact-store.ts` | Object ledger and atomic current-artifact/Outcome commit |
| `packages/agent-db/src/run-events.ts` | Canonical `run_events.type` vocabulary |
| `packages/agent-db/drizzle/` | Shared database migrations |
