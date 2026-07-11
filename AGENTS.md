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
- **chat-api** (`apps/chat-api/`) - AI chat service; owns conversation creation, queued run insertion, durable SSE projection over Postgres `run_events`, and best-effort merging of cursorless Live preview on the original request or an authorized active-Run reconnect
- **agent-worker** (`apps/agent-worker/`) - split-runtime Fargate worker (MYM-47). Owns the worker-only credentials chat-api must not hold (read-only KB, OpenRouter, E2B) and runs the Postgres-backed run queue loop + Claude Agent SDK in trusted Fargate. Today: validated config, structured logger, worker id, bounded-concurrency supervisor, graceful drain, `/health`, the trusted-worker model client config (`src/model-client.ts`: OpenRouter env + default model for the Claude Agent SDK, per ADR-0003), the scoped document query client (`src/documents/` — frozen-scope-guarded KB search/fetch over `KB_DATABASE_URL`, audited to `document_access_events`, bounded model-safe errors) exposed through two model-facing tools (`search-documents-tool.ts` returns citable passages; `load-documents-tool.ts` materializes documents-as-files per ADR-0004 — scope-checked, byte-capped content is written into the conversation's reserved docs cache `.mymemo/docs/` in the sandbox and only `{documentId, title, path, truncated}` metadata is returned, so no document body reaches run events), and the claim/heartbeat/terminalize control loop (`src/run-loop.ts`, Milestone 3): each tick heartbeats owned runs (renew `locked_until`, observe `cancel_requested`/ownership loss) and claims queued runs up to the supervisor's capacity, then processes them via an injected `RunProcessor` (`src/index.ts` wires the real SDK processor over `createStartRunQuery`; the synthetic processor has been removed from production). A successful turn terminalizes `done` directly — there is no end-of-turn checkpoint (ADR-0007): workspace persistence is the paused E2B sandbox itself, which idle-pauses once the turn stops renewing it and reconnects next turn with files intact. The SDK run loop sits behind that same `RunProcessor` seam (`src/sdk/`, Task 7.2): `run-processor.ts` starts a Claude Agent SDK query per claimed run and consumes its stream under supervision (`agent-stream.ts`) — appending assistant text as `run_events` only while `running`, ignoring content after `cancel_requested`, letting SDK errors terminalize as `error`, and interrupting the query on cancel/ownership-loss/shutdown; `run-tools.ts` binds the file/Bash/document executor tools to the run's `{userId, conversationId, runId, sandboxId}`, and `RunLoop.stop()` aborts in-flight runs so shutdown interrupts active queries and cancels active E2B commands. Conversation continuity (ADR-0005, Task 7.3) mirrors the SDK transcript to Postgres through the worker `SessionStore` adapter (`sdk/session-store.ts`, over the shared `agent_sessions` helpers) run under a deterministic per-conversation query cwd so any worker resumes the prior turn; `consumeAgentStream` reports the result session id and any `mirror_error`, and the loop advances the resume pointer `conversation_runtime.agent_session_id` — fenced, only on a clean terminal-success turn (a `mirror_error` turn still ends `done` but holds the pointer) — while conversation deletion drops the transcripts in the cleanup sweep. `start-run-query.ts` (Task 9.5) fills the `startRunQuery` seam: it reads the run's `run_started` event through the shared `loadRunStartedTx` (message → plain-string prompt, frozen scope → document scope, fail-closed parse), ensures the runtime row idempotently and provisions the workspace connect-or-create through the injected `SandboxProvisioner`, persists a fresh sandbox via the fenced pointer update (a fence rejection kills the escaped sandbox — orphan-recording it if the kill fails — and abandons the run to recovery; every pointer replace orphan-records the prior sandbox), keeps the sandbox awake with a per-run monotonic renewal timer (`sandbox-renewal.ts`) whose failure aborts the linked controller so the turn ends `error`, never `done`, and builds the fail-closed ADR-0006 query options (built-ins disabled, no settings sources, `dontAsk` + the executor allowlist, static system prompt, model-client env spread over the worker process env plus an ephemeral `CLAUDE_CONFIG_DIR`, the boot-verified pinned CLI path). The entrypoint now resolves and exec-verifies the SDK's native CLI before claiming, supplies the validated sandbox/file/Bash limits, creates the per-conversation Fargate cwd before each query, and wires `createSdkRunProcessor` over the real `startRunQuery`; failed turns log their internal error worker-side but persist only a generic client message
- **@mymemo/agent-db** (`packages/agent-db/`) - shared writable-DB data layer (`mymemo_agent`): the Drizzle schema, the `Database` client, the concurrency-critical run-store transaction helpers (`claimNextRunTx`/`appendRunEventTx`/`transitionRunTerminalTx`/`heartbeatRunTx`/`requestRunCancellationTx`/`markStaleRunsTx`/`createQueuedRunTx`/`loadRunStartedTx`), the fenced `conversation_runtime`/`orphan_sandboxes` helpers (`runtime-store.ts`: `markRuntimeSandboxTaintedTx`/`updateRuntimeSandboxTx`/`loadConversationRuntimeTx`/`createConversationRuntimeTx`/`recordOrphanSandboxTx`/`advanceAgentSessionPointerTx`), the SDK session-transcript mirror helpers (`session-store.ts`: `appendAgentSessionEntriesTx`/`loadAgentSessionEntriesTx`/`deleteConversationAgentSessionsTx` and friends over the worker-only `agent_sessions` table, ADR-0005), the `run_events.type` write-side vocabulary (`RunEventType`), the PGlite test harness, and the migrations. Imported by BOTH `chat-api` and `agent-worker` so the queue protocol, the runtime-persistence fence AND the event vocabulary have one definition over one `pg` driver (design "Library Choices") — the worker writes `RunEventType.AssistantText`, chat-api's projector maps it to the durable `text_commit` frame, and the worker mutates the sandbox/session pointers through the runtime-store fence. chat-api's `@/db/*` modules, `run-store.ts`, `run-event-types.ts`, and `conversation-runtime-store` re-export from it; run *admission* (`createQueuedRunStartedTx`, `PostgresRunStore`) and the client-frame projector stay in chat-api

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

The chat surface is **two endpoints** under `/v1` (mounted in `src/routes/v1.ts`), modeled on the Managed Agents resource shape — a `conversation` is the durable container, `events` are what you append to it:

1. `POST /v1/conversations` — create a conversation. With:
   - **JSON body** (`CreateConversationBody`, `.strict()`): optional `collectionId` / `summaryId`. Scope is **resolved once from these ids and frozen** onto the conversation record; it is never re-derived per turn.
   - **Identity headers** (`InternalIdentity`): `X-Member-Code` (required), `X-Partner-Code` (required), `X-Team-Code`, `X-Member-Name`, `X-Partner-Name` (all optional). `memberCode` is the conversation owner (`user_id`).
   - Returns `201 { conversationId, scope }`. `conversationId` is **server-generated** (a UUID, path-safe by construction). Persisted via `conversationStore` to chat-api's writable `mymemo_agent` DB. `AGENT_DATABASE_URL` is **required** — validated at config load, so a misconfigured deploy fails fast at startup rather than 503-ing per request.
2. `POST /v1/conversations/:conversationId/events` — append an event and stream the turn. With:
   - **JSON body** (`ConversationEventBody`): a discriminated union over `type` — `{ type: "user.message", text }` (queues a turn, streams SSE) and `{ type: "user.interrupt", runId }` (cancels an existing owned run, returns JSON); extensible to `user.tool_confirmation` etc. without a contract rename. Unknown types → `400`.
   - Same identity headers. The `:conversationId` path param is re-validated as path-safe.
   - The route loads the conversation (scoped to `memberCode`) and returns **`404`** if it does not exist or belongs to another member — a clean gate **before** the SSE stream opens. Then it reads the **frozen** scope from the record (the client cannot widen it) and streams the turn.
   - `user.interrupt` never opens SSE and never creates a run: a queued run terminalizes to `canceled` (appending `run_canceled`) → `202 { runId, status: "canceled" }`; a running run becomes `cancel_requested` (ownership intact; the owning worker terminalizes) → `202 { runId, status: "cancel_requested" }`; an already-terminal run → `409 { runId, status }`; a missing/foreign run → `404`. It bypasses the exposure gate (control of an existing owned run is not new work); the terminal `canceled` frame arrives on the original run's stream or the reconnect endpoint.
3. Both endpoints live in `src/features/conversations/` — `conversations.route.ts` (validation + SSE), `conversations.controller.ts` (`createConversation`, `queueConversationTurn`, `interruptConversationRun`). No upstream API calls here.
4. `queueConversationTurn` is the sole `user.message` path in chat-api. It creates a queued row in `runs` and appends `run_started` to `run_events` in one transaction through `PostgresRunStore`. Concurrency is enforced by the `runs_one_active_per_conversation` partial unique index over active statuses (`queued`, `running`, `cancel_requested`), so busy/backpressure is returned before the SSE stream opens. The turn body cannot carry scope; the queued run event records the frozen conversation scope read from the conversation store. Actual model execution, E2B sandbox use, document access, and terminal/text event appends are worker responsibilities.
5. The authoritative, replayable portion of the client-visible SSE stream is a **projection of the run's recorded events** (each event is persisted durably, then mapped to its frame). chat-api may also merge best-effort cursorless Live preview: prepared before admission on the original request, or subscribed only after ownership authorization on an active-Run reconnect. A terminal historical Run remains Postgres-only. Frames:
   - `conversation_id` — `{ conversationId }`, echoed at run start
   - `run_id` — `{ runId }`, identifies this single backend execution attempt
   - `text_delta` — `{ messageId, deltaIndex, text }`, provisional Live preview; cursorless, available on the original request or an active reconnect, never replayed
   - `text_commit` — `{ messageId, text }`, one authoritative complete Assistant message; carries the durable Run-event SSE cursor
   - `done` — `{}`, marks end-of-stream after the run succeeds
   - `canceled` — `{}`, marks a user-canceled run
   - `error` — `{ message }`, surfaced on agent or transport failure

### Trust Boundary

Identity arrives via `X-*` headers, **not** the JSON body. chat-api does not authenticate users itself; the internal caller (gateway / BFF) is responsible for authenticating the user and forwarding their identity. The body schemas use `.strict()` so any attempt to pass identity in the body is rejected with a 400. This service must therefore only be reachable from trusted internal callers; do not expose the `/v1/conversations*` endpoints directly to untrusted networks. Conversation scope is **frozen at creation** and re-read from the store each turn, so a per-turn request cannot widen it; and the events route only serves a conversation owned by the requesting `memberCode` (else `404`).

**Exposure gate (`src/features/exposure-gate/`):** new agent work is gated by a server-side Statsig gate (`mymemo_agent_split_runtime_enabled`), evaluated on the **trusted identity** (never the body) **after** identity parse and **before** any conversation/run write, on both new-work paths (conversation create and `user.message`). Denied → `403 { error: "Agent is not enabled" }`. It **fails closed**: a Statsig init/eval failure denies new work (a buggy gate cannot fail open). It does **not** replace auth, ownership, DB invariants, or worker fencing, and reconnect/interrupt for existing owned runs must not depend on it. `STATSIG_SERVER_SECRET` backs the production `StatsigExposureGate`; `AGENT_EXPOSURE_BREAK_GLASS=true` swaps in an always-allow gate for local dev / incident response and requires no secret. The secret is never sent to the sandbox or logged.

The sandboxed agent is treated as untrusted (it runs prompt-injectable, Bash-capable code). In the split runtime, chat-api does not mint sandbox credentials or hold provider/document/E2B secrets. The trusted `agent-worker` owns model traffic, scoped document access, and E2B execution; secrets must not be placed into E2B sandbox env.

chat-api holds no provider/document/E2B secrets: it only queues runs and projects durable run events. The trusted `agent-worker` owns model traffic, scoped document access, and E2B sandbox creation.

### Key Modules

| Path | Purpose |
|------|---------|
| `src/features/conversations/` | `conversations.route.ts` (the two endpoints), `conversations.controller.ts` (`createConversation` freezes scope; `queueConversationTurn` creates queued runs) |
| `src/features/conversation-store/` | Durable conversation registry (frozen scope), Drizzle-backed over `mymemo_agent`; `createConversationStore` factory |
| `src/features/exposure-gate/` | `ExposureGate` seam (`exposure-gate.ts`): `StatsigExposureGate` (fail-closed, Statsig-backed) + `BreakGlassExposureGate` (always-allow); `createExposureGate(config)` picks one. Gates new-work routes |
| `src/features/run-store/` | Run *admission* + read surface: `createQueuedRunStartedTx`, `PostgresRunStore`, `ActiveRunExistsError`. Re-exports the shared queue helpers from `@mymemo/agent-db/run-store` so the `@/features/run-store` surface is unchanged |
| `src/features/run-events/` | Durable run-event projection and wake-up plumbing (`project-run.ts`, `project-run-event.ts`, `run-event-reader.ts`, `run-notifier.ts`) |
| `src/features/streaming/` | SSE sender/types reused by the conversation routes (`sse-sender.ts`, `events.ts`) |
| `src/db/` | Thin bindings to `@mymemo/agent-db`: `schema.ts`/`client.ts`/`testing.ts` re-export the shared schema/client/test-harness; `migrate.ts` applies the package's migrations via `MIGRATIONS_DIR`. The schema and `drizzle/` migrations live in the package, not here |
| `src/features/conversation-runtime-store/` | Thin re-export of the shared `@mymemo/agent-db/runtime-store`: persistent E2B workspace metadata over `conversation_runtime` (sandbox pointer, taint state, agent session resume pointer) — every mutation fenced on the claiming run's `locked_by`/`locked_until` — plus the unfenced `orphan_sandboxes` recovery ledger. The helpers live in the shared package so the worker writes through the same fence |
| `src/config/env.ts` | Environment validation |
| `apps/agent-worker/src/run-loop.ts` | `RunLoop` — the worker control loop over the shared helpers: `tick()` heartbeats owned runs (renew/observe cancel) then claims+dispatches queued runs to capacity; `start()`/`stop()` schedule it and drain (`stop()` aborts in-flight runs so shutdown interrupts them). A processor may return a `TurnResult` naming the agent session to advance. `finish()` terminalizes success as `done` directly (ADR-0007); failures are logged with their internal detail but persist only the generic client message `Run failed` |
| `apps/agent-worker/src/sdk/` | SDK run supervision and production query wiring: `agent-stream.ts` persists assistant text while `running`, interrupts on abort, and reports the session id + `mirror_error`; `run-tools.ts` binds the file/Bash/document tools to the run; `run-processor.ts` provides `createSdkRunProcessor`; `session-store.ts` provides Postgres continuity and the deterministic query cwd; `start-run-query.ts` provides fenced connect-or-create provisioning and fail-closed ADR-0006 query options; `sandbox-renewal.ts` keeps the E2B workspace awake during a turn; `claude-code-executable.ts` resolves the SDK-owned non-musl platform binary and exec-verifies it at boot. `src/index.ts` wires these into the live worker |
| `packages/agent-db/` | Shared writable-DB data layer imported by chat-api + agent-worker: `src/schema.ts`, `src/client.ts` (`createDatabase`), `src/run-store.ts` (queue helpers), `src/runtime-store.ts` (fenced `conversation_runtime`/`orphan_sandboxes` helpers + the `agent_session_id` resume pointer), `src/session-store.ts` (worker-only `agent_sessions` SDK transcript-mirror helpers, ADR-0005), `src/run-events.ts` (`RunEventType` vocabulary), `src/testing.ts` (PGlite harness), `src/migrations.ts` (`MIGRATIONS_DIR`), `drizzle/` migrations |

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

Optional:
- `LOG_LEVEL` (default: `info`)
- `PORT` (default: 3000)
- `AGENT_EXPOSURE_BREAK_GLASS` (default: off) — operator break-glass for the agent exposure gate. When `true`, new agent work is allowed without Statsig (local dev, or an incident where Statsig is unavailable) and `STATSIG_SERVER_SECRET` is not required. When off (production default), the gate fails closed
- `DB_PASSWORD` — spliced into `AGENT_DATABASE_URL` when it is passwordless (the form the platform injects)
- `DB_SSL` (default: on; set `disable` for a local non-TLS Postgres)
- `REDIS_URL` — optional authenticated `rediss://` secret for cursorless Live
  preview. Missing, malformed, insecure, or unreachable configuration disables
  only the Live lane; boot, health, and durable Postgres projection remain
  operational. Never logged or passed into E2B

### agent-worker

The worker holds the credentials chat-api must **not** (read-only KB, OpenRouter, E2B). None of these are ever placed into E2B sandbox env (`src/sandbox-env.ts` accepts only the run binding, so secrets cannot structurally leak). Validated once at the entrypoint (`src/config/env.ts`); the process refuses to boot if any required value is missing.

Required:
- `AGENT_DATABASE_URL` — writable `mymemo_agent` DB (runs, run_events, conversation_runtime, worker state). Same DB chat-api uses; the worker is the coordination plane that claims/heartbeats/terminalizes runs
- `KB_DATABASE_URL` — **read-only** KB DB (`mymemo_kb`) for scoped document search. A separate role/credential from `AGENT_DATABASE_URL`
- `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` / `OPENROUTER_DEFAULT_MODEL` — direct OpenRouter (Anthropic-compatible) model traffic; trusted-worker-only
- `E2B_API_KEY` — the untrusted filesystem/shell executor
- `WORKER_E2B_TEMPLATE` — the custom E2B template run sandboxes are created from (Task 9.2, `apps/agent-worker/e2b-template/`): it ships the Grep/Glob toolchain — `rg` installed (the stock `base` template lacks it), `python3` confirmed — with the base image and ripgrep pinned. Build/verify with `bun run template:build` / `bun run template:verify`

Optional:
- `WORKER_MAX_CONCURRENT_RUNS` (default: `2`) — conservative per-task run concurrency; runs share the task's CPU/memory
- `WORKER_SANDBOX_IDLE_MS` (default: `300000`) — E2B idle window; an unrenewed conversation sandbox pauses with its workspace intact
- `WORKER_FILE_GREP_MAX_RESULTS` (default: `100`), `WORKER_FILE_GLOB_MAX_RESULTS` (default: `500`), `WORKER_FILE_READ_MAX_BYTES` (default: `65536`) — model-facing file-tool caps
- `WORKER_BASH_TIMEOUT_MS` (default: `120000`), `WORKER_BASH_MAX_OUTPUT_BYTES` (default: `65536`) — Bash timeout ceiling and per-stream output cap
- `WORKER_DOCUMENT_SEARCH_MAX_RESULTS` (default: `8`) — per-call cap for the model-facing `SearchDocuments` tool before the scoped query client applies its hard backstop
- `WORKER_DOCUMENT_LOAD_MAX_DOCUMENTS` (default: `10`), `WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES` (default: `262144`), `WORKER_DOCUMENT_LOAD_PER_CALL_MAX_BYTES` (default: `1048576`) — caps for the model-facing `LoadDocuments` tool (documents-as-files, ADR-0004): the max ids per call, and the per-document / per-call byte caps on content materialized into the conversation's reserved docs cache
- `WORKER_HEARTBEAT_INTERVAL_MS` (default: `15000`) — how often an active run renews its lease
- `WORKER_SHUTDOWN_TIMEOUT_MS` (default: `30000`) — grace period to drain active runs on SIGINT/SIGTERM before forcing exit
- `WORKER_CLEANUP_INTERVAL_MS` (default: `300000`) — how often the worker-embedded orphan/deleted-conversation cleanup loop (Task 8.1, ADR-0007) attempts a pass; the pass is single-flighted across replicas by a Postgres advisory lock, so only one worker runs it at a time
- `PORT` (default: `8080`) — `/health` endpoint port
- `LOG_LEVEL` (default: `info`)
- `REDIS_URL` — optional authenticated `rediss://` secret for cursorless Live
  preview. Missing, malformed, insecure, or unreachable configuration disables
  only the Live lane; boot, health, and Run execution remain operational. Never
  logged or passed into E2B
- `DB_PASSWORD` — spliced into `AGENT_DATABASE_URL` when passwordless; `DB_SSL` (default: on; `disable` for local non-TLS)

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (X-GPT/mymemo-agent) via the `gh` CLI; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
