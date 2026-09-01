# Database and concurrency

Use this guide for changes to `packages/agent-db`, Drizzle consumers, Run state, Conversation Ownership, Agent sessions, or artifact persistence.

## Ownership

`packages/agent-db` owns the writable `mymemo_agent` schema, Drizzle migrations, database client, canonical `run_events.type` vocabulary, and transaction helpers shared by chat-api, AgentCore, and maintenance. Applications may bind or compose these helpers but must not create competing definitions.

The package exposes concurrency-critical operations including `acquireAgentCoreDispatchTx`, `appendRunEventsTx`, `transitionRunTerminalTx`, `requestRunInterruptionTx`, `reclaimConversationTx`, `expireUnownedQueuedRunsTx`, `admitQueuedRunTx`, `loadExecutingRunTx`, and `loadRunStartedTx`.

chat-api imports the shared client and schema directly. Its migration entrypoint imports `MIGRATIONS_DIR` from `@mymemo/agent-db/migrations` and applies `packages/agent-db/drizzle/`.

`document_access_events.run_id` holds a Run id (the Run path's document tools), a Harness turn id (chat-api's document tools on the AI SDK chat path), or a v2 Turn's user-message id (the In-VM server's in-process document tools).

## Store boundaries

- `src/conversation-ownership.ts`: live Ownership predicates, lease renewal, release, and mutation fences
- `src/run-store.ts`: fenced Run start, event append, terminalization, interruption, Live Stream marker writes, executing-Run observation, expiration, and Reclamation
- `src/runtime-store.ts`: fenced Run sandbox/taint mutations, in-transaction Agent session pointer updates, Reclamation tainting, and the orphan-sandbox ledger
- `src/session-store.ts`: Ownership-fenced production Run append/delete operations, transcript reads, and administrative Conversation transcript deletion
- `src/artifact-store.ts`: pre-upload object ledger and fence-first atomic artifact-pointer/current-metadata/`run_done` commit
- `src/turn-store.ts`: /v2 Turn-queue primitives on `conversation_messages` (enqueue, one-in-flight claim, at-most-once terminalization, boot sweep, queued-cancel) and the Turn's single assistant-row upsert
- `src/testing.ts`: PGlite harness and shared seed helpers

chat-api's `PostgresRunStore` composes shared admission inside the Conversation lifecycle lock. The new Run, its `run_started` event, and its Run-keyed dispatch outbox row share that transaction; exact retries insert nothing. Run-store operations compose runtime pointer publication into qualifying terminal transactions through the same live Ownership fence.

## Concurrency tests

PGlite tests cover transaction behavior that one in-process backend can express. AgentCore Reclamation races that require concurrent sessions live in `src/conversation-ownership.postgres.test.ts` and run in the real-Postgres integration lane:

- concurrent reclaimers splitting lapsed Conversations through `SKIP LOCKED`
- Reclamation skipping a Conversation row held by another session
- queued-Run expiration racing Reclamation

Turn-queue races (concurrent claimers, racing terminalizers) live in `packages/agent-db/src/turn-store.postgres.test.ts`. AgentCore outbox/acquisition races live in `packages/agent-db/src/agentcore-dispatch.postgres.test.ts`. The dedicated publisher task's deployment-overlap exclusion and backend-termination release live in `apps/agentcore-dispatch-publisher/src/publisher-loop.postgres.test.ts`; it additionally requires `RUN_AGENTCORE_PUBLISHER_POSTGRES_TESTS=true` so the publisher app's local `.env` cannot accidentally target a database during its ordinary unit suite. These tests require `AGENT_DATABASE_URL` and run in the CI `integration` job against the Postgres major used in production.

## Drizzle dependency identity

Drizzle schema and SQL objects cross package boundaries, so all consumers must resolve one `drizzle-orm` instance. Follow the dependency rule in [Development and verification](development.md); do not solve instance mismatches with casts.
