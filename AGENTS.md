# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

Source: [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)

## Project Overview

MyMemo Monorepo (Bun workspaces) containing:
- **chat-api** (`apps/chat-api/`) - AI chat service; owns Conversation creation and lifecycle management, strict/idempotent AG-UI Run admission, producer-buffered Live Stream relay attachment for original POST and reconnect, permanent Conversation history over Postgres `run_events`, and ownership-checked listing/signing of the Conversation's current Downloadable artifacts
- **agent-worker** (`apps/agent-worker/`) - split-runtime Fargate worker (MYM-47). Owns the worker-only credentials chat-api must not hold (read-only KB, OpenRouter, E2B) and runs the Postgres-backed run queue loop + Claude Agent SDK in trusted Fargate. Today: validated config, structured logger, worker id, bounded-concurrency supervisor, graceful drain, `/health`, the trusted-worker model client config (`src/model-client.ts`: OpenRouter env + default model for the Claude Agent SDK, per ADR-0003), the scoped document query client (`src/documents/` — frozen-scope-guarded KB list/search/fetch over `KB_DATABASE_URL`, audited to `document_access_events`, bounded model-safe errors) exposed through three model-facing tools (`list-documents-tool.ts` returns exact scoped inventory counts and metadata; `search-documents-tool.ts` returns citable passages; `load-documents-tool.ts` materializes documents-as-files per ADR-0004 — scope-checked, byte-capped content is written into the conversation's reserved docs cache `.mymemo/docs/` in the sandbox and only `{documentId, title, path, truncated}` metadata is returned, so no document body reaches run events), and the claim/heartbeat/terminalize control loop (`src/run-loop.ts`, Milestone 3): each tick heartbeats owned runs (renew `locked_until`, observe `cancel_requested`/ownership loss) and claims queued runs up to the supervisor's capacity, then processes them via an injected `RunProcessor` (`src/index.ts` wires the real SDK processor over `createStartRunQuery`; the synthetic processor has been removed from production). A successful turn terminalizes `done` directly — there is no end-of-turn checkpoint (ADR-0007): workspace persistence is the paused E2B sandbox itself, which idle-pauses once the turn stops renewing it and reconnects next turn with files intact. The SDK run loop sits behind that same `RunProcessor` seam (`src/sdk/`, Task 7.2): `run-processor.ts` starts a Claude Agent SDK query per claimed run and consumes its stream under supervision (`agent-stream.ts`) — appending assistant text as `run_events` only while `running`, ignoring content after `cancel_requested`, letting SDK errors terminalize as `error`, and interrupting the query on cancel/ownership-loss/shutdown; `run-tools.ts` binds the file/Bash/document executor tools to the run's `{userId, conversationId, runId, sandboxId}`, and `RunLoop.stop()` aborts in-flight runs so shutdown interrupts active queries and cancels active E2B commands. Conversation continuity (ADR-0005, Task 7.3) mirrors the SDK transcript to Postgres through the worker `SessionStore` adapter (`sdk/session-store.ts`, over the shared `agent_sessions` helpers) run under a deterministic per-conversation query cwd so any worker resumes the prior turn; `consumeAgentStream` reports the result session id and any `mirror_error`, and the loop advances the resume pointer `conversation_runtime.agent_session_id` — fenced, only on a clean terminal-success turn (a `mirror_error` turn still ends `done` but holds the pointer) — while conversation deletion drops the transcripts in the cleanup sweep. `start-run-query.ts` (Task 9.5) fills the `startRunQuery` seam: it reads the run's `run_started` event through the shared `loadRunStartedTx` (message → plain-string prompt, frozen scope → document scope, fail-closed parse), ensures the runtime row idempotently and provisions the workspace connect-or-create through the injected `SandboxProvisioner`, persists a fresh sandbox via the fenced pointer update (a fence rejection kills the escaped sandbox — orphan-recording it if the kill fails — and abandons the run to recovery; every pointer replace orphan-records the prior sandbox), keeps the sandbox awake with a per-run monotonic renewal timer (`sandbox-renewal.ts`) whose failure aborts the linked controller so the turn ends `error`, never `done`, and builds the fail-closed ADR-0006 query options (built-ins disabled, no settings sources, `dontAsk` + the executor allowlist, static system prompt, model-client env spread over the worker process env plus an ephemeral `CLAUDE_CONFIG_DIR`, the boot-verified pinned CLI path). The entrypoint now resolves and exec-verifies the SDK's native CLI before claiming, supplies the validated sandbox/file/Bash limits, creates the per-conversation Fargate cwd before each query, and wires `createSdkRunProcessor` over the real `startRunQuery`; failed turns log their internal error worker-side but persist only a generic client message. Successful turns compare start/end manifests under `/home/user/artifacts`, ledger fresh private object keys before upload, and commit changed current-artifact metadata atomically with `run_done`
- **@mymemo/agent-db** (`packages/agent-db/`) - shared writable-DB data layer (`mymemo_agent`): the Drizzle schema, the `Database` client, the concurrency-critical run-store transaction helpers (`claimNextRunTx`/`appendRunEventTx`/`transitionRunTerminalTx`/`heartbeatRunTx`/`requestRunCancellationTx`/`markStaleRunsTx`/`admitQueuedRunTx`/`loadRunStartedTx`), the fenced `conversation_runtime`/`orphan_sandboxes` helpers, the SDK session-transcript mirror helpers over the worker-only `agent_sessions` table, the canonical `run_events.type` write-side vocabulary (`RunEventType`), the PGlite test harness, and the migrations. Both runtimes import it so the queue protocol, runtime-persistence fence, and permanent-history event vocabulary share one definition over one `pg` driver. The worker mutates sandbox/session pointers through the runtime-store fence; chat-api's `PostgresRunStore` composes transaction-scoped shared admission with the Conversation lifecycle lock

The prototype-path services (`gateway`, `sandbox-daemon`, `mymemo-docs`, `@mymemo/llm-token`) were removed once the split runtime replaced them end to end (ADR-0002).

## Commands

### chat-api (apps/chat-api/)

```bash
# Development
bun install          # Install dependencies
bun run dev          # Start dev server with hot reload at localhost:3000

# Code quality (Biome)
bun run lint         # Lint and auto-fix
bun run format       # Format code

# Docker
docker build -t chat-api .
docker-compose up    # Local development
```

### AWS CLI

Always use the `mymemo` profile: `aws --profile mymemo ...`

## Architecture (chat-api)

### Request Flow

The agent and Downloadable-artifact surface is mounted under `/v1` in `src/routes/v1.ts`. A Conversation is the durable container, a Run serves one submitted message, and artifacts are the current named files available for download:

1. `POST /v1/conversations` — create a conversation. With:
   - **JSON body** (`CreateConversationBody`, `.strict()`): optional `collectionId` / `summaryId`. Scope is **resolved once from these ids and frozen** onto the conversation record; it is never re-derived per turn.
   - **Identity headers** (`InternalIdentity`): `X-Member-Code` (required), `X-Partner-Code` (required), `X-Team-Code`, `X-Member-Name`, `X-Partner-Name` (all optional). `memberCode` is the conversation owner (`user_id`).
   - Returns the standard summary `201 { conversationId, title, scope, createdAt, lastActivityAt, archivedAt }`; a new empty draft has `title: null` and `archivedAt: null`. `conversationId` is **server-generated** (a UUID, path-safe by construction). Persisted via `conversationStore` to chat-api's writable `mymemo_agent` DB. `AGENT_DATABASE_URL` is **required** — validated at config load, so a misconfigured deploy fails fast at startup rather than 503-ing per request.
2. Conversation management is owner-scoped and bypasses the new-work exposure gate: `GET /v1/conversations` lists the regular or archived partition with server-side title search and stable activity-keyset pagination as `{ conversations, nextCursor }`; `PATCH /v1/conversations/:conversationId` renames or archives/unarchives while serializing Archive transitions with Run admission; `DELETE /v1/conversations/:conversationId` rejects active Runs and permanently deletes the Conversation's durable data. Missing and foreign Conversations return `404`.
3. `POST /v1/conversations/:conversationId/runs` — strictly validate one standard `RunAgentInput`, require `threadId` to equal the owned Conversation id, reject client Tools/state/forwarded authority, and atomically admit the client-supplied `runId` plus final plain-text User message through `admitAgUiRun`. Exact retries reattach to the same logical Run; mismatched reuse returns `409`. Admission commits before any Redis access. The response and `GET /v1/conversations/:conversationId/runs/:runId/events` attach to the producer-buffered per-Run Live Stream relay, emitting standard AG-UI JSON in data-only SSE frames. Every active attach receives the full backlog plus live tail; an incoming `Last-Event-ID` is ignored. While no producer answers, chat-api retries under Postgres Run state and holds SSE open with keepalives. A relay failure before the first event returns retryable `503`; a later failure closes the incomplete stream without a synthesized protocol event. Terminal Runs return the `410` Conversation-history recovery signal without relay attachment.
4. `POST /v1/conversations/:conversationId/runs/:runId/cancel` — canonical durable cancellation. A queued Run terminalizes to `canceled`, while a running or already-`cancel_requested` Run becomes/remains `cancel_requested`; both return `202 { runId, status }`. A terminal Run returns `409`; a missing or foreign Run returns the same ownership-safe `404`. Cancellation bypasses the new-work exposure gate.
5. `GET /v1/conversations/:conversationId/history` — owner-scoped permanent history, paged as complete Runs with standard AG-UI messages and a separate terminal event. Postgres remains authoritative after the producer-buffered Live Stream ends or fails.
6. `GET /v1/conversations/:conversationId/artifacts` and `GET /v1/conversations/:conversationId/artifacts/:artifactId/download-url` — list the current Downloadable set or return `{ downloadUrl }` with a fresh five-minute S3 URL. Both verify Conversation ownership and bypass the new-work exposure gate.
7. The Conversation endpoints live in `src/features/conversations/`; permanent history lives in `src/features/conversation-history/`; artifacts live in `src/features/artifacts/`. `admitAgUiRun` is the sole Run admission path and transactionally writes the queued `runs` row plus `run_started`, preserving client Run/message identity for exact retry under the Conversation lifecycle lock. The `runs_one_active_per_conversation` partial unique index enforces backpressure.
8. The producer-buffered relay is the only live/reconnect transport. The worker buffers standard AG-UI `RUN_STARTED`, Assistant text lifecycle, Tool lifecycle, and terminal events in memory and publishes them over Redis pub/sub; Redis stores no stream content. Permanent Assistant messages, Tool activity, and Outcomes commit to Postgres before their matching completion events are published. Runtime relay failure degrades live delivery without changing service health or Run execution.

### Trust Boundary

Identity arrives via `X-*` headers, **not** the JSON body. chat-api does not authenticate users itself; the internal caller (gateway / BFF) authenticates the user and forwards identity. Body schemas are strict. This service must therefore only be reachable from trusted internal callers. Conversation scope is frozen at creation and every resource is owner-scoped.

**Exposure gate (`src/features/exposure-gate/`):** new agent work is gated by a server-side Statsig gate (`mymemo_agent_split_runtime_enabled`), evaluated on the **trusted identity** (never the body) **after** identity parse and **before** any Conversation or Run write. Denied → `403 { error: "Agent is not enabled" }`. It fails closed. Reconnect, cancellation, history, and artifact access for existing owned resources do not consult it.

The sandboxed agent is treated as untrusted (it runs prompt-injectable, Bash-capable code). In the split runtime, chat-api does not mint sandbox credentials or hold provider/document/E2B secrets. The trusted `agent-worker` owns model traffic, scoped document access, and E2B execution; secrets must not be placed into E2B sandbox env.

chat-api holds no provider/document/E2B secrets. It admits Runs, attaches to AG-UI Live Stream relays, reads permanent history and Downloadable-artifact metadata, and signs read-only artifact URLs. The trusted `agent-worker` owns model traffic, scoped document access, E2B sandbox creation, relay event production, and Downloadable-artifact publication.

### Key Modules

| Path | Purpose |
|------|---------|
| `src/features/conversations/` | Conversation resources, strict AG-UI Run admission, relay-backed SSE/reconnect, and canonical cancellation |
| `src/features/conversation-history/` | Owner-scoped permanent history projection over canonical Postgres Run events |
| `src/features/artifacts/` | Ownership-checked current-artifact list/download routes, the Postgres metadata adapter, and the injected five-minute S3 download signer |
| `src/features/conversation-store/` | Durable conversation registry (frozen scope), Drizzle-backed over `mymemo_agent`; `createConversationStore` factory |
| `src/features/exposure-gate/` | `ExposureGate` seam (`exposure-gate.ts`): `StatsigExposureGate` (fail-closed, Statsig-backed) + `BreakGlassExposureGate` (always-allow); `createExposureGate(config)` picks one. Gates new-work routes |
| `src/features/run-store/` | Strict Run admission, ownership-scoped Run reads, and durable cancellation over the shared queue helpers |
| `src/db/` | Thin bindings to `@mymemo/agent-db`: `schema.ts`/`client.ts`/`testing.ts` re-export the shared schema/client/test-harness; `migrate.ts` applies the package's migrations via `MIGRATIONS_DIR`. The schema and `drizzle/` migrations live in the package, not here |
| `src/features/conversation-runtime-store/` | Thin re-export of the shared `@mymemo/agent-db/runtime-store`: persistent E2B workspace metadata over `conversation_runtime` (sandbox pointer, taint state, agent session resume pointer) — every mutation fenced on the claiming run's `locked_by`/`locked_until` — plus the unfenced `orphan_sandboxes` recovery ledger. The helpers live in the shared package so the worker writes through the same fence |
| `src/config/env.ts` | Environment validation |
| `apps/agent-worker/src/run-loop.ts` | `RunLoop` — the worker control loop over the shared helpers: heartbeat/claim/dispatch plus best-effort relay-backed AG-UI production through `RunLiveStream`. It opens one producer per claimed Run, exposes `RUN_STARTED` after claim, publishes terminal AG-UI only after the matching Postgres transition, then closes the producer and frees its buffer. Relay failure disables only live output. `finish()` still terminalizes success directly per ADR-0007. The optional `RunDoorbell` provides low-latency pickup while timer ticks remain authoritative |
| `apps/agent-worker/src/artifacts/` | Successful-Run publication for Downloadable outputs: start/end workspace manifests, pre-upload `artifact_objects` ledgering, binary-safe private S3 upload, and the adapter seams used by PGlite tests |
| `apps/agent-worker/src/sdk/` | SDK run supervision and production query wiring: `agent-stream.ts` emits standard Assistant text start/content, persists the canonical complete Assistant message, then emits text end; it also persists MyMemo-identified, correlated Tool lifecycle events before their live AG-UI projections while `running`, interrupts on abort, and reports session id + `mirror_error`. The remaining tool/session/query/sandbox modules retain their documented ADR-0004/0005/0006/0012 responsibilities. `src/index.ts` wires the SDK processor and Redis Live Stream relay into the live worker |
| `packages/live-text/` | Shared required Redis URL validation, producer-buffered in-memory/Redis relay implementations, payload-safe delivery telemetry, and the unused legacy retained store pending deletion |
| `packages/agent-db/` | Shared writable-DB data layer imported by chat-api + agent-worker: `src/schema.ts`, `src/client.ts` (`createDatabase`), `src/run-store.ts` (queue helpers), `src/runtime-store.ts` (fenced `conversation_runtime`/`orphan_sandboxes` helpers + the `agent_session_id` resume pointer), `src/session-store.ts` (worker-only `agent_sessions` SDK transcript-mirror helpers, ADR-0005), `src/artifact-store.ts` (pre-upload `artifact_objects` ledger and atomic current-metadata/`run_done` commit), `src/run-events.ts` (`RunEventType` vocabulary), `src/testing.ts` (PGlite harness), `src/migrations.ts` (`MIGRATIONS_DIR`), `drizzle/` migrations |

### Chat Scopes

Resolved once at `POST /v1/conversations` and **frozen** onto the conversation record (every turn re-reads it; it never changes for the conversation's lifetime):

- `general` - no `collectionId` / `summaryId` provided
- `collection` - `collectionId` provided
- `document` - `summaryId` provided (takes precedence over `collectionId`)

## Code Style

- **Formatter**: Biome with tab indentation, double quotes
- **Import organization**: Enabled via Biome
- **Path aliases**: `@/*` maps to `./src/*`

### Single Drizzle instance invariant

`@mymemo/agent-db` exchanges Drizzle schema/SQL objects across the package
boundary (chat-api and agent-worker call the shared helpers and also build their
own SQL with `drizzle-orm`). Those objects only type-check when every workspace
member resolves the **same** `drizzle-orm` instance. Bun forks `drizzle-orm`
into distinct same-version instances when its optional-peer context differs, and
`@electric-sql/pglite` (used by the package's PGlite test harness) is one such
optional peer. So any workspace member that uses `drizzle-orm` must also carry
`@electric-sql/pglite` as a devDependency to keep the context — and therefore
the resolved instance — identical. Adding a new drizzle consumer, or dropping
pglite from one, reintroduces the dual-instance type errors; keep the peer set
aligned instead of casting around them.

## Environment Variables

### chat-api

Required:
- `AGENT_DATABASE_URL` — connection to chat-api's **own writable** Postgres (`mymemo_agent`), which backs the conversation registry (frozen scope), run queue, and run event log. A **separate database and credential** from the worker's read-only KB (`mymemo_kb`), even when co-located — chat-api never touches KB tables. Named `AGENT_DATABASE_URL` (not the generic `DATABASE_URL`, which names the read-only KB credential elsewhere) so the two trust domains never collide. **Required**: the conversation endpoints are the primary surface and cannot work without it, so it is validated at config load. The `conversations`/`runs`/`run_events` tables are owned by Drizzle migrations (`src/db/schema.ts` → `drizzle/`); run `bun run db:migrate` (the compose `migrate` one-shot does this locally)
- `STATSIG_SERVER_SECRET` — backs the production agent exposure gate (`mymemo_agent_split_runtime_enabled`). **Required unless `AGENT_EXPOSURE_BREAK_GLASS=true`** (the gate then opens without Statsig). Never sent to the sandbox or logged
- `ARTIFACT_BUCKET` — private S3 bucket holding Downloadable artifact objects; chat-api receives read-only object access
- `AWS_REGION` — region used to construct the artifact S3 client and signer
- `REDIS_URL` — authenticated `rediss://` secret for the per-Run AG-UI Live Stream relay. Missing, malformed, unauthenticated, or non-TLS configuration fails startup. Never logged

Optional:
- `LOG_LEVEL` (default: `info`)
- `PORT` (default: 3000)
- `AGENT_EXPOSURE_BREAK_GLASS` (default: off) — operator break-glass for the agent exposure gate. When `true`, new agent work is allowed without Statsig (local dev, or an incident where Statsig is unavailable) and `STATSIG_SERVER_SECRET` is not required. When off (production default), the gate fails closed
- `DB_PASSWORD` — spliced into `AGENT_DATABASE_URL` when it is passwordless (the form the platform injects)
- `DB_SSL` (default: on; set `disable` for a local non-TLS Postgres)
- `LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS` (default: off) — integration-test-only
  escape hatch; when exactly `true`, accepts unauthenticated `redis://` only for
  `localhost`, `127.0.0.1`, or `[::1]`. Never use in a deployed environment

### agent-worker

The worker holds the credentials chat-api must **not** (read-only KB, OpenRouter, E2B). None of these are ever placed into E2B sandbox env (`src/sandbox-env.ts` accepts only the run binding, so secrets cannot structurally leak). Validated once at the entrypoint (`src/config/env.ts`); the process refuses to boot if any required value is missing.

Required:
- `AGENT_DATABASE_URL` — writable `mymemo_agent` DB (runs, run_events, conversation_runtime, worker state). Same DB chat-api uses; the worker is the coordination plane that claims/heartbeats/terminalizes runs
- `KB_DATABASE_URL` — **read-only** KB DB (`mymemo_kb`) for scoped document search. A separate role/credential from `AGENT_DATABASE_URL`
- `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` / `OPENROUTER_DEFAULT_MODEL` — direct OpenRouter (Anthropic-compatible) model traffic; trusted-worker-only
- `E2B_API_KEY` — the untrusted filesystem/shell executor
- `WORKER_E2B_TEMPLATE` — the custom E2B template run sandboxes are created from (Task 9.2, `apps/agent-worker/e2b-template/`): it ships the Grep/Glob toolchain — `rg` installed (the stock `base` template lacks it), `python3` confirmed — with the base image and ripgrep pinned. Build/verify with `bun run template:build` / `bun run template:verify`
- `ARTIFACT_BUCKET` — private S3 bucket for changed Downloadable outputs; the worker receives object-upload access only
- `AWS_REGION` — region used to construct the worker's artifact S3 client
- `REDIS_URL` — authenticated `rediss://` secret for the per-Run AG-UI Live Stream relay. Missing, malformed, unauthenticated, or non-TLS configuration fails startup. Never logged or passed into E2B

Optional:
- `WORKER_MAX_CONCURRENT_RUNS` (default: `2`) — conservative per-task run concurrency; runs share the task's CPU/memory
- `WORKER_SANDBOX_IDLE_MS` (default: `300000`) — E2B idle window; an unrenewed conversation sandbox pauses with its workspace intact
- `WORKER_FILE_GREP_MAX_RESULTS` (default: `100`), `WORKER_FILE_GLOB_MAX_RESULTS` (default: `500`), `WORKER_FILE_READ_MAX_BYTES` (default: `65536`) — model-facing file-tool caps
- `WORKER_BASH_TIMEOUT_MS` (default: `120000`), `WORKER_BASH_MAX_OUTPUT_BYTES` (default: `65536`) — Bash timeout ceiling and per-stream output cap
- `WORKER_DOCUMENT_LIST_MAX_RESULTS` (default: `20`) — per-page cap for the model-facing `ListDocuments` inventory tool before its hard backstop of 100
- `WORKER_DOCUMENT_SEARCH_MAX_RESULTS` (default: `8`) — per-call cap for the model-facing `SearchDocuments` tool before the scoped query client applies its hard backstop
- `WORKER_DOCUMENT_LOAD_MAX_DOCUMENTS` (default: `10`), `WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES` (default: `262144`), `WORKER_DOCUMENT_LOAD_PER_CALL_MAX_BYTES` (default: `1048576`) — caps for the model-facing `LoadDocuments` tool (documents-as-files, ADR-0004): the max ids per call, and the per-document / per-call byte caps on content materialized into the conversation's reserved docs cache
- `WORKER_HEARTBEAT_INTERVAL_MS` (default: `15000`) — how often an active run renews its lease
- `WORKER_SHUTDOWN_TIMEOUT_MS` (default: `30000`) — grace period to drain active runs on SIGINT/SIGTERM before forcing exit
- `WORKER_CLEANUP_INTERVAL_MS` (default: `300000`) — how often the worker-embedded orphan/deleted-conversation cleanup loop (Task 8.1, ADR-0007) attempts a pass; the pass is single-flighted across replicas by a Postgres advisory lock, so only one worker runs it at a time
- `PORT` (default: `8080`) — `/health` endpoint port
- `LOG_LEVEL` (default: `info`)
- `LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS` (default: off) — integration-test-only
  loopback exception with the same exact host and value restrictions as chat-api
- `DB_PASSWORD` — spliced into `AGENT_DATABASE_URL` when passwordless; `DB_SSL` (default: on; `disable` for local non-TLS)

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (X-GPT/mymemo-agent) via the `gh` CLI; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
