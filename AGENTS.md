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
- **chat-api** (`apps/chat-api/`) - AI chat service; orchestrates per-user E2B sandboxes
- **sandbox-daemon** (`apps/sandbox-daemon/`) - in-sandbox HTTP daemon; bundled and shipped into E2B
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
   - Returns `201 { conversationId, scope }`. `conversationId` is **server-generated** (a UUID, path-safe by construction). Persisted via `conversationStore` to chat-api's writable `mymemo_agent` DB. `DATABASE_URL` is **required** — validated at config load, so a misconfigured deploy fails fast at startup rather than 503-ing per request.
2. `POST /v1/conversations/:conversationId/events` — append an event and stream the turn. With:
   - **JSON body** (`ConversationEventBody`): a discriminated union over `type`. Today only `{ type: "user.message", text }`; extensible to `user.interrupt` / `user.tool_confirmation` without a contract rename. Unknown types → `400`.
   - Same identity headers. The `:conversationId` path param is re-validated as path-safe.
   - The route loads the conversation (scoped to `memberCode`) and returns **`404`** if it does not exist or belongs to another member — a clean gate **before** the SSE stream opens. Then it reads the **frozen** scope from the record (the client cannot widen it) and streams the turn.
3. Both endpoints live in `src/features/conversations/` — `conversations.route.ts` (validation + SSE), `conversations.controller.ts` (`createConversation`, `runConversationTurn`). No upstream API calls here.
4. `runSandboxChat` is the sole agent path: creates a fresh per-user E2B sandbox each turn and forwards the turn (with the conversation's frozen scope) to its daemon. The daemon's `bindConversationScope` records the scope on the first turn and rejects a mismatched scope on later turns — a backstop to chat-api being the authority. `agentSessionId` is currently `null` (conversation continuity is a later milestone; a fresh agent session starts each turn). chat-api mints a short-lived `@mymemo/llm-token` bound to `{userId, sandboxId, requestId}` and sends it (with `GATEWAY_PUBLIC_URL`) in the turn body. The daemon sets these as `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` on the agent process, so **the sandbox never holds a provider key** — all LLM calls route through the `gateway`, which validates the token and injects the real `ANTHROPIC_API_KEY`. The agent accesses the user's documents on demand via the `mymemo-docs` CLI (on PATH in the sandbox template), which calls the same `gateway` with the same per-turn token (sent as `MYMEMO_DOC_GATEWAY_URL` + `MYMEMO_DOC_TOKEN`); the gateway enforces the turn's **signed scope** server-side. The Claude binary and the CLI reach the one merged gateway through two independent env vars that both point at `GATEWAY_PUBLIC_URL` (the binary hits `/v1/messages`, the CLI hits `/v1/documents/*`). Documents are **not** materialized to the sandbox filesystem.
5. The client-visible SSE stream is a **projection of the run's recorded events** (each event is persisted durably, then mapped to its frame). Frames:
   - `conversation_id` — `{ conversationId }`, echoed at run start
   - `run_id` — `{ runId }`, identifies this single backend execution attempt
   - `sandbox_id` — `{ sandboxId }`, the E2B sandbox created for this turn (a fresh sandbox is created per turn)
   - `agent_session_id` — `{ sessionId }`, the daemon-assigned Claude SDK session for this turn
   - `text_delta` — `{ text }`, one event per streamed token chunk; the client concatenates these
   - `done` — `{}`, marks end-of-stream, emitted only after the whole run (including workspace sync) succeeds
   - `error` — `{ message }`, surfaced on agent or transport failure

### Trust Boundary

Identity arrives via `X-*` headers, **not** the JSON body. chat-api does not authenticate users itself; the internal caller (gateway / BFF) is responsible for authenticating the user and forwarding their identity. The body schemas use `.strict()` so any attempt to pass identity in the body is rejected with a 400. This service must therefore only be reachable from trusted internal callers; do not expose the `/v1/conversations*` endpoints directly to untrusted networks. Conversation scope is **frozen at creation** and re-read from the store each turn, so a per-turn request cannot widen it; and the events route only serves a conversation owned by the requesting `memberCode` (else `404`).

The sandboxed agent is treated as untrusted (it runs prompt-injectable, Bash-capable code). It holds no provider key and no document credential — only a short-lived, single-user, signed bearer token whose claims include the turn's document scope. The inbound edges from a sandbox are **sandbox → gateway** (for both LLM and document calls); the gateway holds the real credentials + `LLM_TOKEN_SECRET`, should only be reachable from sandboxes, and reaches only its two upstreams (`api.anthropic.com` and the MyMemo KB Postgres). Because scope is signed into the token and enforced by the gateway's document routes, a prompt-injected agent cannot read documents outside its turn's scope. chat-api mints the token; the gateway verifies it; the daemon never sees `LLM_TOKEN_SECRET`.

The **chat-api → daemon `/turn`** edge has no application-layer auth and the daemon holds no secret of its own (MYM-35). In prod each E2B sandbox is created with `allowPublicTraffic: false`, so its edge rejects any request to the daemon's public URL that lacks the per-sandbox `e2b-traffic-access-token` (held only by chat-api, sent on every daemon call); chat-api fails the sandbox create if that token is absent, so the restriction can't silently fail open. Locally the daemon container is unpublished on the compose network. The previous shared `DAEMON_AUTH_TOKEN` bearer was removed: it lived in the daemon's process env where the untrusted agent could read it via `/proc`, yet it was redundant with the edge and identical across all sandboxes.

**Merge tradeoff (be aware):** the LLM proxy and the document reader used to be two separate services (`llm-gateway` + `document-gateway`), each holding exactly one credential. They are now one `gateway` process that holds BOTH `ANTHROPIC_API_KEY` and `DATABASE_URL` and has a single egress identity reaching both Anthropic and the KB Postgres. This is a wider blast radius — a compromise of the gateway now exposes both credentials at once — accepted as the cost of running one deployable control plane instead of two. The token still has no audience/capability claim, so one token is valid on both route families; that was already true when they were separate and is unchanged by the merge.

### Key Modules

| Path | Purpose |
|------|---------|
| `src/features/conversations/` | `conversations.route.ts` (the two endpoints), `conversations.controller.ts` (`createConversation` freezes scope; `runConversationTurn` reads it back and hands the turn to the sandbox) |
| `src/features/conversation-store/` | Durable conversation registry (frozen scope), Drizzle-backed over `mymemo_agent`; `createConversationStore` factory |
| `src/features/streaming/` | SSE / run-event plumbing reused by the conversation routes (`sse-sender.ts`, `events.ts`, `logger.ts` → `RequestLogger`, `run-event-sink.ts`, `run-events-to-sse.ts`) |
| `src/db/` | Drizzle schema (`schema.ts`: `conversations`, `sandbox_leases`), client (`client.ts`), and migration runner (`migrate.ts`) for the writable DB; migrations in `drizzle/` |
| `src/features/sandbox-orchestration/` | `runSandboxChat`, sandbox manager, daemon proxy; mints the per-turn LLM token |
| `src/features/sandbox-agent/` | Sandbox-side agent system prompt builder |
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
- `E2B_API_KEY` — required only when `SANDBOX_PROVIDER=e2b` (the default); not needed for the local provider
- `LLM_TOKEN_SECRET` — HMAC secret for minting per-turn tokens (shared with the gateway)
- `GATEWAY_PUBLIC_URL` — base URL of the merged gateway; the sandbox agent points BOTH the Claude binary (→ `/v1/messages`) and the `mymemo-docs` CLI (→ `/v1/documents/*`) at it. **Must be reachable from inside the E2B sandbox**
- `DATABASE_URL` — connection to chat-api's **own writable** Postgres (`mymemo_agent`), which backs the conversation registry (frozen scope) and the sandbox-lease registry. A **separate database and credential** from the gateway's read-only KB (`mymemo_kb`), even when co-located — chat-api never touches KB tables. **Required**: the conversation endpoints are the primary surface and cannot work without it, so it is validated at config load. The `conversations`/`sandbox_leases` tables are owned by Drizzle migrations (`src/db/schema.ts` → `drizzle/`); run `bun run db:migrate` (the compose `migrate` one-shot does this locally)

Optional:
- `LOG_LEVEL` (default: `info`)
- `PORT` (default: 3000)
- `SANDBOX_PROVIDER` (default: `e2b`) — `e2b` leases a fresh sandbox per turn; `local` targets a long-lived daemon container for the docker-compose E2E harness (`compose.yaml`). Selected in `sandbox-orchestration/singleton.ts`
- `LOCAL_SANDBOX_DAEMON_URL` (default: `http://sandbox:8080`) — base URL of the local daemon container (`SANDBOX_PROVIDER=local` only)
- `E2B_TEMPLATE` (default: `sandbox-template-dev`)
- `WORKSPACE_STORE_ROOT` — root dir of the durable workspace store (local filesystem `WorkspaceStore` adapter). Holds per-user/per-conversation work, output, and the docs manifest, plus per-run event logs, following the path model `users/{userId}/conversations/{conversationId}/…` and `users/{userId}/runs/{runId}/events.jsonl`. Defaults to `.workspace-store` under the process cwd (writable in the container). **For durability across container recycles, point this at a mounted persistent volume in production**
- `DB_PASSWORD` — spliced into `DATABASE_URL` when it is passwordless (the form the platform injects)
- `DB_SSL` (default: on; set `disable` for a local non-TLS Postgres)

### gateway

Required:
- `ANTHROPIC_API_KEY` — the real Anthropic provider key; lives **only** in this service. **Required only when `LLM_PROVIDER=anthropic`** (the default); an OpenRouter-only deployment does not need it
- `DATABASE_URL` — read-only connection to the MyMemo KB Postgres; this **read-only KB credential** lives **only** in this service (chat-api has its own, separate `DATABASE_URL` for its writable `mymemo_agent` DB — it is never the KB credential)
- `LLM_TOKEN_SECRET` — must match chat-api's

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
