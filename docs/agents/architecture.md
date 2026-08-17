# System architecture

Use this guide when a change crosses service or package boundaries. For canonical terminology, read [the domain guide](domain.md) and the relevant [ADRs](../adr/).

## Components

| Component | Responsibility |
| --- | --- |
| `apps/chat-api` | Creates and manages Conversations, admits Runs idempotently, attaches clients to Live Streams, projects permanent history, and lists or signs current Downloadable artifacts. |
| `apps/agent-worker` | Trusted Fargate execution runtime. Claims Conversations, serves their Runs in submission order, calls the Claude Agent SDK through OpenRouter, accesses scoped Searchable documents, delegates untrusted file and shell work to E2B, and publishes artifacts. |
| `apps/agent-worker/src/agentcore-dispatch/main.ts` | Dedicated AgentCore Dispatch publication process. Runs as one ECS task, separate from Conversation-serving workers. |
| `apps/agentcore-canary-dispatch` | Production-shaped AgentCore dispatch boundary: transactional outbox publication, strict content-free SQS envelopes, exact acquisition, manual replay, and partial-batch acknowledgement. Its boundary ends after the exact Run reaches `running`. |
| `apps/agentcore-canary-runtime` | Linux ARM64 AgentCore Runtime exposing `/ping` and `/invocations`. It serves one acquired canary Run and delegates the already-running Run to shared Run-serving behavior. It does not run Fargate Claim, drain, expiration, Reclamation, or cleanup loops. |
| `packages/agent-db` | Shared writable `mymemo_agent` data layer: schema, migrations, Run and Conversation Ownership transactions, runtime pointers, session transcripts, artifact metadata, and PGlite test support. |
| `packages/live-text` | Redis configuration, event validation, and producer-buffered in-memory/Redis Live Stream relay implementations. |

The removed `gateway`, `sandbox-daemon`, `mymemo-docs`, and `@mymemo/llm-token` services belong to the superseded prototype path and are not fallbacks. See [ADR-0002](../adr/0002-hard-swap-no-coexistence-flag.md).

## Cross-component invariants

### Conversation control plane

A Fargate worker Claims a Conversation and serves the Runs present in that Claim's snapshot one at a time in submission order. AgentCore exact acquisition establishes the same live Conversation Ownership boundary for its selected Run. See [ADR-0015](../adr/0015-conversation-level-ownership-with-epoch.md), [ADR-0022](../adr/0022-acquire-an-agentcore-dispatch-atomically.md), and [the worker guide](agent-worker.md).

Every execution mutation is fenced by the live Conversation Ownership epoch and lease. Reclamation terminalizes started Runs after a lapsed lease, leaves unstarted queued Runs for the next Claim, taints the Workspace when cleanup is unproven, and clears Ownership.

### Live and permanent output

The worker keeps each active Run's standard AG-UI Live Stream backlog in memory and relays events over Redis pub/sub. Redis stores no stream content. Permanent Assistant messages, Tool activity, UI payloads, and Outcomes commit to Postgres before their matching completion events are published. Relay failure degrades live delivery without changing durable Run execution. See [ADR-0014](../adr/0014-producer-buffered-live-stream-over-pubsub.md).

Workspace persistence, Agent session continuity, Searchable document loading, and Downloadable artifact publication belong to the trusted runtime. Follow [the worker guide](agent-worker.md) for their detailed invariants.

## Module map

| Path | Purpose |
| --- | --- |
| `apps/chat-api/src/features/conversations/` | Conversation resources, strict AG-UI Run admission, relay-backed SSE/reconnect, and interruption |
| `apps/chat-api/src/features/conversation-history/` | Owner-scoped permanent history over canonical Run events |
| `apps/chat-api/src/features/artifacts/` | Current-artifact listing and five-minute S3 download signing |
| `apps/chat-api/src/features/conversation-store/` | Durable Conversation registry and frozen Scope |
| `apps/chat-api/src/features/exposure-gate/` | Statsig and break-glass implementations of the new-work gate |
| `apps/chat-api/src/features/runtime-gate/` | Fail-safe Statsig selection of the immutable Conversation execution runtime |
| `apps/chat-api/src/features/run-store/` | Run admission, owner-scoped Run reads, and durable interruption |
| `apps/chat-api/src/features/conversation-runtime-store/` | Thin re-export of shared fenced Workspace, taint, and Agent session runtime persistence |
| `apps/chat-api/src/db/` | Thin bindings to `@mymemo/agent-db` and the shared migration runner |
| `apps/agent-worker/src/run-loop.ts` | Fargate-only Claim, ordering, expiration, Reclamation, and release control plane |
| `apps/agent-worker/src/agentcore-dispatch/` | Dedicated AgentCore Dispatch publication entrypoint, loop, and production adapters |
| `apps/agent-worker/src/run-serving.ts` | Shared serving behavior for an already-running Run |
| `apps/agent-worker/src/sdk/` | SDK query wiring, transcript mirroring, tools, and AG-UI event projection |
| `apps/agent-worker/src/artifacts/` | Artifact discovery, upload, and publication for Runs with a `done` Outcome |
| `packages/agent-db/src/conversation-ownership.ts` | Claim protocol and live Ownership fence |
| `packages/agent-db/src/run-store.ts` | Fenced Run state and Run event transactions |
| `packages/agent-db/src/runtime-store.ts` | Fenced sandbox, taint, and Agent session pointers plus orphan ledger |
| `packages/agent-db/src/session-store.ts` | Worker-fenced SDK transcript mutation and administrative deletion |
| `packages/agent-db/src/artifact-store.ts` | Object ledger and atomic current-artifact/Outcome commit |
| `packages/agent-db/src/run-events.ts` | Canonical `run_events.type` vocabulary |
| `packages/agent-db/drizzle/` | Shared database migrations |
