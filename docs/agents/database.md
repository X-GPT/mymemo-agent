# Database and concurrency

Use this guide for changes to `packages/agent-db`, Drizzle consumers, Run state, Conversation Ownership, Agent sessions, or artifact persistence.

## Ownership

`packages/agent-db` owns the writable `mymemo_agent` schema, Drizzle migrations, database client, canonical `run_events.type` vocabulary, and transaction helpers shared by chat-api and both trusted execution paths. Applications may bind or compose these helpers but must not create competing definitions.

The package exposes concurrency-critical operations including `startClaimedRunTx`, `appendRunEventTx`, `transitionRunTerminalTx`, `requestRunInterruptionTx`, `reclaimConversationTx`, `expireUnownedQueuedRunsTx`, `admitQueuedRunTx`, `loadExecutingRunTx`, and `loadRunStartedTx`.

`apps/chat-api/src/db/` is a thin binding layer. Its migration entrypoint imports `MIGRATIONS_DIR` from `@mymemo/agent-db/migrations` and applies `packages/agent-db/drizzle/`.

## Store boundaries

- `src/conversation-ownership.ts`: live Ownership predicates, fence-first locking, Claim plus snapshot, lease renewal, and unconditional release
- `src/run-store.ts`: fenced Run start, event append, terminalization, interruption, Live Stream marker writes, executing-Run observation, expiration, and Reclamation
- `src/runtime-store.ts`: fenced sandbox and taint mutations, in-transaction Agent session pointer updates, Reclamation tainting, and the deliberately unfenced orphan-sandbox ledger
- `src/session-store.ts`: worker-fenced Agent session append/delete operations, deliberately unfenced transcript reads, and administrative Conversation transcript deletion
- `src/artifact-store.ts`: pre-upload object ledger and fence-first atomic artifact-pointer/current-metadata/`run_done` commit
- `src/testing.ts`: PGlite harness and shared seed helpers

chat-api's `PostgresRunStore` composes shared admission inside the Conversation lifecycle lock. Run-store operations compose runtime pointer publication into qualifying terminal transactions through the same live Ownership fence.

## Concurrency tests

PGlite tests cover transaction behavior that one in-process backend can express. The following races require real Postgres and live in `src/conversation-ownership.postgres.test.ts`:

- `SKIP LOCKED` Claim contention
- the Claim-versus-admission snapshot boundary
- concurrent reclaimers
- a superseded holder racing its successor

AgentCore publisher/acquisition races live in `src/canary-dispatch.postgres.test.ts`. These tests are gated on `AGENT_DATABASE_URL` and run in the CI `integration` job against the Postgres major used in production.

## Drizzle dependency identity

Drizzle schema and SQL objects cross package boundaries, so all consumers must resolve one `drizzle-orm` instance. Follow the dependency rule in [Development and verification](development.md); do not solve instance mismatches with casts.
