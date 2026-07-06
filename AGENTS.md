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
- **chat-api** (`apps/chat-api/`) - AI chat service; owns conversation creation, queued run insertion, and durable SSE projection over Postgres `run_events`
- **agent-worker** (`apps/agent-worker/`) - split-runtime Fargate worker (deployable skeleton; MYM-47). Owns the worker-only credentials chat-api must not hold (read-only KB, OpenRouter, E2B) and will run the Postgres-backed run queue loop + Claude Agent SDK in trusted Fargate. Today: validated config, structured logger, worker id, bounded-concurrency supervisor, graceful drain, `/health`, the trusted-worker model client config (`src/model-client.ts`: OpenRouter env + default model for the Claude Agent SDK, per ADR-0003), and the scoped document query client (`src/documents/` — frozen-scope-guarded KB search/fetch over `KB_DATABASE_URL`, audited to `document_access_events`, bounded model-safe errors). The queue/claim loop arrives in a later milestone
- **sandbox-daemon** (`apps/sandbox-daemon/`) - in-sandbox HTTP daemon; bundled and shipped into E2B (prototype path)
- **gateway** (`apps/gateway/`) - control plane; the only service holding BOTH the real `ANTHROPIC_API_KEY` and the read-only KB `DATABASE_URL`. Verifies the per-turn bearer token on every route, proxies the Anthropic Messages endpoints, and serves scope-enforced document search/fetch against the MyMemo KB Postgres
- **mymemo-docs** (`apps/mymemo-docs/`) - CLI on the sandbox PATH that the agent uses to reach the gateway's document endpoints
- **@mymemo/llm-token** (`packages/llm-token/`) - shared package

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

## Architecture (chat-api)

### Request Flow

The chat surface is **two endpoints** under `/v1` (mounted in `src/routes/v1.ts`), modeled on the Managed Agents resource shape — a `conversation` is the durable container, `events` are what you append to it:

1. `POST /v1/conversations` — create a conversation. With:
   - **JSON body** (`CreateConversationBody`, `.strict()`): optional `collectionId` / `summaryId`. Scope is **resolved once from these ids and frozen** onto the conversation record; it is never re-derived per turn.
   - **Identity headers** (`InternalIdentity`): `X-Member-Code` (required), `X-Partner-Code` (required), `X-Team-Code`, `X-Member-Name`, `X-Partner-Name` (all optional). `memberCode` is the conversation owner (`user_id`).
   - Returns `201 { conversationId, scope }`. `conversationId` is **server-generated** (a UUID, path-safe by construction). Persisted via `conversationStore` to chat-api's writable `mymemo_agent` DB. `AGENT_DATABASE_URL` is **required** — validated at config load, so a misconfigured deploy fails fast at startup rather than 503-ing per request.
2. `POST /v1/conversations/:conversationId/events` — append an event and stream the turn. With:
   - **JSON body** (`ConversationEventBody`): a discriminated union over `type`. Today only `{ type: "user.message", text }`; extensible to `user.interrupt` / `user.tool_confirmation` without a contract rename. Unknown types → `400`.
   - Same identity headers. The `:conversationId` path param is re-validated as path-safe.
   - The route loads the conversation (scoped to `memberCode`) and returns **`404`** if it does not exist or belongs to another member — a clean gate **before** the SSE stream opens. Then it reads the **frozen** scope from the record (the client cannot widen it) and streams the turn.
3. Both endpoints live in `src/features/conversations/` — `conversations.route.ts` (validation + SSE), `conversations.controller.ts` (`createConversation`, `queueConversationTurn`). No upstream API calls here.
4. `queueConversationTurn` is the sole `user.message` path in chat-api. It creates a queued row in `runs` and appends `run_started` to `run_events` in one transaction through `PostgresRunStore`. Concurrency is enforced by the `runs_one_active_per_conversation` partial unique index over active statuses (`queued`, `running`, `cancel_requested`), so busy/backpressure is returned before the SSE stream opens. The turn body cannot carry scope; the queued run event records the frozen conversation scope read from the conversation store. Actual model execution, E2B sandbox use, document access, and terminal/text event appends are worker responsibilities.
5. The client-visible SSE stream is a **projection of the run's recorded events** (each event is persisted durably, then mapped to its frame). Frames:
   - `conversation_id` — `{ conversationId }`, echoed at run start
   - `run_id` — `{ runId }`, identifies this single backend execution attempt
   - `text_delta` — `{ text }`, one event per streamed token chunk; the client concatenates these
   - `done` — `{}`, marks end-of-stream after the run succeeds
   - `canceled` — `{}`, marks a user-canceled run
   - `error` — `{ message }`, surfaced on agent or transport failure

### Trust Boundary

Identity arrives via `X-*` headers, **not** the JSON body. chat-api does not authenticate users itself; the internal caller (gateway / BFF) is responsible for authenticating the user and forwarding their identity. The body schemas use `.strict()` so any attempt to pass identity in the body is rejected with a 400. This service must therefore only be reachable from trusted internal callers; do not expose the `/v1/conversations*` endpoints directly to untrusted networks. Conversation scope is **frozen at creation** and re-read from the store each turn, so a per-turn request cannot widen it; and the events route only serves a conversation owned by the requesting `memberCode` (else `404`).

**Exposure gate (`src/features/exposure-gate/`):** new agent work is gated by a server-side Statsig gate (`mymemo_agent_split_runtime_enabled`), evaluated on the **trusted identity** (never the body) **after** identity parse and **before** any conversation/run write, on both new-work paths (conversation create and `user.message`). Denied → `403 { error: "Agent is not enabled" }`. It **fails closed**: a Statsig init/eval failure denies new work (a buggy gate cannot fail open). It does **not** replace auth, ownership, DB invariants, or worker fencing, and reconnect/interrupt for existing owned runs must not depend on it. `STATSIG_SERVER_SECRET` backs the production `StatsigExposureGate`; `AGENT_EXPOSURE_BREAK_GLASS=true` swaps in an always-allow gate for local dev / incident response and requires no secret. The secret is never sent to the sandbox or logged.

The sandboxed agent is treated as untrusted (it runs prompt-injectable, Bash-capable code). In the split runtime, chat-api does not mint sandbox credentials or hold provider/document/E2B secrets. The trusted `agent-worker` owns model traffic, scoped document access, and E2B execution; secrets must not be placed into E2B sandbox env.

The former chat-api → sandbox-daemon `/turn` edge is removed from chat-api's live path. The trusted `agent-worker` will own E2B sandbox creation and any executor-to-sandbox traffic in the split runtime; chat-api only queues runs and projects durable run events.

**Merge tradeoff (be aware):** the LLM proxy and the document reader used to be two separate services (`llm-gateway` + `document-gateway`), each holding exactly one credential. They are now one `gateway` process that holds BOTH `ANTHROPIC_API_KEY` and `DATABASE_URL` and has a single egress identity reaching both Anthropic and the KB Postgres. This is a wider blast radius — a compromise of the gateway now exposes both credentials at once — accepted as the cost of running one deployable control plane instead of two. Each per-turn token carries an `aud` claim (`llm` or `documents`) that the gateway enforces per route family, so an LLM token cannot reach the document routes and a document token cannot spend on the LLM — a leaked token is confined to one family. The merge widened the gateway's credential blast radius (above) but did not weaken this per-token audience separation.

### Key Modules

| Path | Purpose |
|------|---------|
| `src/features/conversations/` | `conversations.route.ts` (the two endpoints), `conversations.controller.ts` (`createConversation` freezes scope; `queueConversationTurn` creates queued runs) |
| `src/features/conversation-store/` | Durable conversation registry (frozen scope), Drizzle-backed over `mymemo_agent`; `createConversationStore` factory |
| `src/features/exposure-gate/` | `ExposureGate` seam (`exposure-gate.ts`): `StatsigExposureGate` (fail-closed, Statsig-backed) + `BreakGlassExposureGate` (always-allow); `createExposureGate(config)` picks one. Gates new-work routes |
| `src/features/run-store/` | Durable run queue/event-log store over `runs` and `run_events`; queues `user.message` turns and replays run events |
| `src/features/run-events/` | Durable run-event projection and wake-up plumbing (`project-run.ts`, `project-run-event.ts`, `run-event-reader.ts`, `run-notifier.ts`) |
| `src/features/streaming/` | SSE sender/types reused by the conversation routes (`sse-sender.ts`, `events.ts`) |
| `src/db/` | Drizzle schema (`schema.ts`: `conversations`, `runs`, `run_events`, `conversation_runtime`, `orphan_sandboxes`), client (`client.ts`), and migration runner (`migrate.ts`) for the writable DB; migrations in `drizzle/` |
| `src/features/conversation-runtime-store/` | Persistent E2B workspace metadata over `conversation_runtime` (sandbox pointer, snapshot rotation, checkpoint/taint state) — every mutation fenced on the claiming run's `locked_by`/`locked_until` — plus the unfenced `orphan_sandboxes` recovery ledger |
| `src/config/env.ts` | Environment validation |
| `apps/gateway/src/server.ts` | `createGateway(config, db)` — the merged control plane: registers health, then the document routes, then the catch-all LLM proxy (order is correctness-critical). Pure: config in, app out |
| `apps/gateway/src/auth/` | `bearer.ts` (the one shared `bearerClaims` token-verify seam + 401/403 helpers) and `claims.ts` (`requireDocumentClaims` scope guard) |
| `apps/gateway/src/llm/` | `proxy.ts` (Anthropic proxy: path-allowlisted `/v1/messages*`, injects `ANTHROPIC_API_KEY`) and `routes.ts` (catch-all registration) |
| `apps/gateway/src/documents/` | `routes.ts` — the scope-enforced `/v1/documents/*` handlers |
| `apps/gateway/src/db/` | `client.ts` (the `Db` seam / `createDb`) and `queries.ts` (parameterized FTS / scope-resolution SQL against the KB Postgres) |
| `apps/gateway/src/env.ts` | `loadConfigFromEnv(env): GatewayConfig` — parse/validate env once into a typed config |
| `apps/gateway/src/index.ts` | Entrypoint: the only place that reads `Bun.env`; builds config + db and serves the app |
| `packages/llm-token/index.ts` | `mintLlmToken` / `verifyLlmToken` (shared, HMAC-signed) |

### Chat Scopes

Resolved once at `POST /v1/conversations` and **frozen** onto the conversation record (every turn re-reads it; it never changes for the conversation's lifetime):

- `general` - no `collectionId` / `summaryId` provided
- `collection` - `collectionId` provided
- `document` - `summaryId` provided (takes precedence over `collectionId`)

## Code Style

- **Formatter**: Biome with tab indentation, double quotes
- **Import organization**: Enabled via Biome
- **Path aliases**: `@/*` maps to `./src/*`

## Environment Variables

### chat-api

Required:
- `AGENT_DATABASE_URL` — connection to chat-api's **own writable** Postgres (`mymemo_agent`), which backs the conversation registry (frozen scope), run queue, and run event log. A **separate database and credential** from the gateway's read-only KB (`mymemo_kb`), even when co-located — chat-api never touches KB tables. Named `AGENT_DATABASE_URL` (not the generic `DATABASE_URL`, which names the read-only KB credential elsewhere) so the two trust domains never collide. **Required**: the conversation endpoints are the primary surface and cannot work without it, so it is validated at config load. The `conversations`/`runs`/`run_events` tables are owned by Drizzle migrations (`src/db/schema.ts` → `drizzle/`); run `bun run db:migrate` (the compose `migrate` one-shot does this locally)
- `STATSIG_SERVER_SECRET` — backs the production agent exposure gate (`mymemo_agent_split_runtime_enabled`). **Required unless `AGENT_EXPOSURE_BREAK_GLASS=true`** (the gate then opens without Statsig). Never sent to the sandbox or logged

Optional:
- `LOG_LEVEL` (default: `info`)
- `PORT` (default: 3000)
- `AGENT_EXPOSURE_BREAK_GLASS` (default: off) — operator break-glass for the agent exposure gate. When `true`, new agent work is allowed without Statsig (local dev, or an incident where Statsig is unavailable) and `STATSIG_SERVER_SECRET` is not required. When off (production default), the gate fails closed
- `DB_PASSWORD` — spliced into `AGENT_DATABASE_URL` when it is passwordless (the form the platform injects)
- `DB_SSL` (default: on; set `disable` for a local non-TLS Postgres)

### agent-worker

The worker holds the credentials chat-api must **not** (read-only KB, OpenRouter, E2B). None of these are ever placed into E2B sandbox env (`src/sandbox-env.ts` accepts only the run binding, so secrets cannot structurally leak). Validated once at the entrypoint (`src/config/env.ts`); the process refuses to boot if any required value is missing.

Required:
- `AGENT_DATABASE_URL` — writable `mymemo_agent` DB (runs, run_events, conversation_runtime, worker state). Same DB chat-api uses; the worker is the coordination plane that claims/heartbeats/terminalizes runs
- `KB_DATABASE_URL` — **read-only** KB DB (`mymemo_kb`) for scoped document search. A separate role/credential from `AGENT_DATABASE_URL`
- `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` / `OPENROUTER_DEFAULT_MODEL` — direct OpenRouter (Anthropic-compatible) model traffic; trusted-worker-only
- `E2B_API_KEY` — the untrusted filesystem/shell executor

Optional:
- `WORKER_MAX_CONCURRENT_RUNS` (default: `2`) — conservative per-task run concurrency; runs share the task's CPU/memory
- `WORKER_DOCUMENT_SEARCH_MAX_RESULTS` (default: `8`) — per-call cap for the model-facing `SearchDocuments` tool before the scoped query client applies its hard backstop
- `WORKER_HEARTBEAT_INTERVAL_MS` (default: `15000`) — how often an active run renews its lease
- `WORKER_SHUTDOWN_TIMEOUT_MS` (default: `30000`) — grace period to drain active runs on SIGINT/SIGTERM before forcing exit
- `PORT` (default: `8080`) — `/health` endpoint port
- `LOG_LEVEL` (default: `info`)
- `DB_PASSWORD` — spliced into `AGENT_DATABASE_URL` when passwordless; `DB_SSL` (default: on; `disable` for local non-TLS)

### gateway

Required:
- `ANTHROPIC_API_KEY` — the real Anthropic provider key; lives **only** in this service. **Required only when `LLM_PROVIDER=anthropic`** (the default); an OpenRouter-only deployment does not need it
- `DATABASE_URL` — read-only connection to the MyMemo KB Postgres; this **read-only KB credential** lives **only** in this service (chat-api has its own, separate `DATABASE_URL` for its writable `mymemo_agent` DB — it is never the KB credential)
- `LLM_TOKEN_SECRET` — shared signing secret for accepted `@mymemo/llm-token` bearer tokens

Optional:
- `UPSTREAM_BASE_URL` (default: `https://api.anthropic.com`) — Anthropic upstream base (`LLM_PROVIDER=anthropic` only)
- `LLM_PROVIDER` (default: `anthropic`) — which LLM upstream the proxy forwards to: `anthropic` injects the real `x-api-key` and talks to the Anthropic Messages API directly; `openrouter` forwards to OpenRouter's Anthropic-compatible Messages endpoint with a gateway-only bearer key. Gateway-side policy; the sandbox is unaware of it
- `OPENROUTER_API_KEY` — gateway-only OpenRouter secret, injected as `Authorization: Bearer` on the upstream request only. **Required when `LLM_PROVIDER=openrouter`**; never minted into a token or sent to the sandbox
- `OPENROUTER_BASE_URL` (e.g. `https://openrouter.ai/api`) — OpenRouter base (trailing slash stripped). **Required when `LLM_PROVIDER=openrouter`**
- `OPENROUTER_DEFAULT_MODEL` — default model deployment policy picks. **Required when `LLM_PROVIDER=openrouter`** (full model allowlist/rewriting is Task 18)
- `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_TITLE` — optional OpenRouter attribution headers (`HTTP-Referer` / `X-Title`)
- `DB_PASSWORD` — spliced into `DATABASE_URL` when it is passwordless (the form the platform injects)
- `DB_SSL` (default: on; set `disable` for a local non-TLS Postgres)
- `GATEWAY_PORT` (default: 8080)

Compatibility note: the OpenRouter adapter is gated to the proven Claude-SDK-compatible surface — only `/v1/messages` forwards; `/v1/messages/count_tokens` is not part of OpenRouter's Anthropic-compatible surface and fails closed (404). `anthropic` remains the default until OpenRouter compatibility is verified end-to-end.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (X-GPT/mymemo-agent) via the `gh` CLI; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
