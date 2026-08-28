# System architecture

Use this guide when a change crosses service or package boundaries. For canonical terminology, read [the domain guide](domain.md) and the relevant [ADRs](../adr/).

## Components

| Component | Responsibility |
| --- | --- |
| `apps/chat-api` | Creates and manages Conversations, admits Runs idempotently, attaches clients to Live Streams, projects permanent history, and lists or signs current Downloadable artifacts. |
| `packages/agent-worker` | Maintenance-only implementation package composed by agent-maintenance. It is not a deployed service or image. |
| `apps/agent-maintenance` | Sole production owner of global queued-Run expiration, Reclamation, and asynchronous cleanup. It has no Run-serving path. |
| `apps/agentcore-dispatch-publisher` | Dedicated AgentCore Dispatch publication app. Runs as one ECS task, separate from chat-api and AgentCore Runtime. |
| `apps/agentcore-dispatch-consumer` | AgentCore dispatch consumer Lambda and shared dispatch-boundary modules. Its production composition validates strict content-free SQS envelopes, invokes the Runtime, and returns partial-batch acknowledgements; the Runtime composes exact acquisition directly. |
| `apps/agentcore-runtime` | Sole production execution runtime. The Linux ARM64 image exposes `/ping` and `/invocations`, exactly acquires one dispatched Run, and owns its Run-serving behavior. |
| `apps/agentcore-local-dispatch-bridge` | Development-only outbox poller that composes the shared publisher and consumer contracts against a local AgentCore Runtime. It is absent from production startup paths and images. |
| `packages/agent-db` | Shared writable `mymemo_agent` data layer: schema, migrations, Run and Conversation Ownership transactions, runtime pointers, session transcripts, artifact metadata, and PGlite test support. |
| `packages/agentcore-dispatch` | Production-neutral AgentCore Dispatch publication behavior, strict envelope serialization, and separately importable SQS and SSM adapters. |
| `packages/live-text` | Redis configuration, event validation, and producer-buffered in-memory/Redis Live Stream relay implementations. |

The removed `gateway`, `sandbox-daemon`, `mymemo-docs`, and `@mymemo/llm-token` services belong to the superseded prototype path and are not fallbacks. See [ADR-0002](../adr/0002-hard-swap-no-coexistence-flag.md).

## Cross-component invariants

### Conversation control plane

AgentCore exact acquisition atomically starts the dispatched Run and establishes
its live Conversation Ownership boundary. There is no queue Claim, runtime
selection, persisted runtime discriminator, or fallback execution path. See
[ADR-0022](../adr/0022-acquire-an-agentcore-dispatch-atomically.md),
[ADR-0031](../adr/0031-make-agentcore-the-sole-execution-runtime.md), and [the
Run-serving guide](agentcore-runtime.md).

Every execution mutation is fenced by the live Conversation Ownership epoch and lease. The maintenance service terminalizes started Runs after a lapsed lease, leaves unstarted queued Runs for a later Dispatch retry, taints the Workspace when cleanup is unproven, and clears Ownership.

### Live and permanent output

The AgentCore Runtime keeps each active Run's standard AG-UI Live Stream backlog in memory and relays events over Redis-compatible pub/sub through ElastiCache for Valkey. The cache stores no stream content. Permanent Assistant messages, Tool activity, UI payloads, and Outcomes commit to Postgres before their matching completion events are published. Relay failure degrades live delivery without changing durable Run execution. See [ADR-0014](../adr/0014-producer-buffered-live-stream-over-pubsub.md).

Workspace persistence, Agent session continuity, Searchable document loading, and Downloadable artifact publication belong to the trusted runtime. Follow [the Runtime guide](agentcore-runtime.md) for their detailed invariants.

## Module map

| Path | Purpose |
| --- | --- |
| `apps/chat-api/src/features/conversations/` | Conversation resources, strict AG-UI Run admission, relay-backed SSE/reconnect, and interruption |
| `apps/chat-api/src/features/conversation-history/` | Owner-scoped permanent history over canonical Run events |
| `apps/chat-api/src/features/artifacts/` | Current-artifact listing and five-minute S3 download signing |
| `apps/chat-api/src/features/conversation-store/` | Durable Conversation registry and frozen Scope |
| `apps/chat-api/src/features/exposure-gate/` | Production Statsig implementation of the new-work gate |
| `apps/chat-api/src/features/run-store/` | Run admission, owner-scoped Run reads, and durable interruption |
| `apps/chat-api/src/db/` | Thin bindings to `@mymemo/agent-db` and the shared migration runner |
| `apps/agent-maintenance/src/` | Production entrypoint and health surface for global maintenance |
| `packages/agent-worker/src/maintenance-runner.ts` | Shared queued-Run expiration, Reclamation, and cleanup implementation composed only by agent-maintenance |
| `apps/agentcore-dispatch-publisher/src/` | Dedicated AgentCore Dispatch publication entrypoint, loop, and production adapters |
| `apps/agentcore-runtime/src/run-serving.ts` | Serving behavior for an already-running Run |
| `apps/agentcore-runtime/src/sdk/` | SDK query wiring, transcript mirroring, tools, and AG-UI event projection |
| `apps/agentcore-runtime/src/artifacts/` | Artifact discovery, upload, and publication for Runs with a `done` Outcome |
| `apps/chat-api/src/features/ai-chat/` | Harness-hosted AI SDK chat route (`POST /api/chat`, local composition only): one Claude Code turn per message on a per-turn `HarnessAgent` with every built-in off, in a persistent Vercel Sandbox per Conversation, streamed as the UI message stream |
| `apps/chat-api/src/features/ai-chat/tools/` | The Harness tool-name list the agent's `activeTools` derives from (the chat-api-hosted Harness tool set lands here) |
| `packages/agentcore-dispatch/src/` | Shared AgentCore Dispatch publisher policy, envelope serialization, and isolated SQS/SSM adapters |
| `packages/agent-db/src/conversation-ownership.ts` | Live Ownership renew, release, and mutation fence |
| `packages/agent-db/src/run-store.ts` | Fenced Run state and Run event transactions |
| `packages/agent-db/src/runtime-store.ts` | Runtime Workspace pointers, taint, Agent session pointers, and orphan ledger; Run mutations are Ownership-fenced |
| `packages/agent-db/src/session-store.ts` | Production Run SDK transcript persistence under the Ownership fence |
| `packages/agent-db/src/artifact-store.ts` | Object ledger and atomic current-artifact/Outcome commit |
| `packages/agent-db/src/run-events.ts` | Canonical `run_events.type` vocabulary |
| `packages/agent-db/drizzle/` | Shared database migrations |
