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

1. `POST /api/v1/chat` with:
   - **JSON body** (`ChatBodyRequest`): chat payload — `chatContent`, optional `collectionId`/`summaryId`/`sessionId`
   - **Identity headers** (`InternalIdentity`): `X-Member-Code` (required), `X-Partner-Code` (required), `X-Team-Code`, `X-Member-Name`, `X-Partner-Name` (all optional)
2. SSE stream initiated in `chat.route.ts` after body validation (`.strict()`, rejects extra keys) and identity-header validation (401 on missing/invalid)
3. `chat.controller.ts::complete()` orchestrates the merged request — no upstream API calls
4. `runSandboxChat` is the sole agent path: creates a fresh per-user E2B sandbox each turn and forwards the turn to its daemon. The optional `sessionId` from the request body is passed through as the daemon's `agent_session_id`; when omitted, the daemon allocates a new session. chat-api mints a short-lived `@mymemo/llm-token` bound to `{userId, sandboxId, requestId}` and sends it (with `GATEWAY_PUBLIC_URL`) in the turn body. The daemon sets these as `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` on the agent process, so **the sandbox never holds a provider key** — all LLM calls route through the `gateway`, which validates the token and injects the real `ANTHROPIC_API_KEY`. The agent accesses the user's documents on demand via the `mymemo-docs` CLI (on PATH in the sandbox template), which calls the same `gateway` with the same per-turn token (sent as `MYMEMO_DOC_GATEWAY_URL` + `MYMEMO_DOC_TOKEN`); the gateway enforces the turn's **signed scope** server-side. The Claude binary and the CLI reach the one merged gateway through two independent env vars that both point at `GATEWAY_PUBLIC_URL` (the binary hits `/v1/messages`, the CLI hits `/v1/documents/*`). Documents are **not** materialized to the sandbox filesystem.
5. Events emitted via SSE:
   - `text_delta` — `{ text }` payload, one event per streamed token chunk; the client concatenates these to build the full response
   - `done` — `{}` payload, marks end-of-stream after the final `text_delta`
   - `session_id` — `{ sessionId }`, daemon-assigned conversation session; clients must persist and echo back to resume
   - `sandbox_id` — `{ sandboxId }`, the E2B sandbox created for this turn (a fresh sandbox is created per turn)
   - `error` — `{ message }`, surfaced on agent or transport failure

### Trust Boundary

Identity arrives via `X-*` headers, **not** the JSON body. chat-api does not authenticate users itself; the internal caller (gateway / BFF) is responsible for authenticating the user and forwarding their identity. The body schema uses `.strict()` so any attempt to pass identity in the body is rejected with a 400. This service must therefore only be reachable from trusted internal callers; do not expose `POST /api/v1/chat` directly to untrusted networks.

The sandboxed agent is treated as untrusted (it runs prompt-injectable, Bash-capable code). It holds no provider key and no document credential — only a short-lived, single-user, signed bearer token whose claims include the turn's document scope. The inbound edges from a sandbox are **sandbox → gateway** (for both LLM and document calls); the gateway holds the real credentials + `LLM_TOKEN_SECRET`, should only be reachable from sandboxes, and reaches only its two upstreams (`api.anthropic.com` and the MyMemo KB Postgres). Because scope is signed into the token and enforced by the gateway's document routes, a prompt-injected agent cannot read documents outside its turn's scope. chat-api mints the token; the gateway verifies it; the daemon never sees `LLM_TOKEN_SECRET`.

**Merge tradeoff (be aware):** the LLM proxy and the document reader used to be two separate services (`llm-gateway` + `document-gateway`), each holding exactly one credential. They are now one `gateway` process that holds BOTH `ANTHROPIC_API_KEY` and `DATABASE_URL` and has a single egress identity reaching both Anthropic and the KB Postgres. This is a wider blast radius — a compromise of the gateway now exposes both credentials at once — accepted as the cost of running one deployable control plane instead of two. The token still has no audience/capability claim, so one token is valid on both route families; that was already true when they were separate and is unchanged by the merge.

### Key Modules

| Path | Purpose |
|------|---------|
| `src/features/chat/chat.controller.ts` | Reads context from request body, hands the turn to the sandbox |
| `src/features/sandbox-orchestration/` | `runSandboxChat`, sandbox manager, daemon proxy; mints the per-turn LLM token |
| `src/features/sandbox-agent/` | Sandbox-side agent system prompt builder |
| `src/config/env.ts` | Environment validation |
| `apps/gateway/src/gateway.ts` | `createGateway(config, db)` — the merged control plane: one `bearerClaims` token-verify helper; document routes (`/v1/documents/*`, scope-enforced) registered before the catch-all Anthropic proxy (`/v1/messages*`, path-allowlisted, injects `ANTHROPIC_API_KEY`). Pure: config in, app out |
| `apps/gateway/src/config.ts` | `loadConfigFromEnv(env): GatewayConfig` — parse/validate env once into a typed config |
| `apps/gateway/src/index.ts` | Entrypoint: the only place that reads `Bun.env`; builds config + db and serves the app |
| `apps/gateway/src/queries.ts` | Parameterized FTS / scope-resolution SQL against the KB Postgres |
| `packages/llm-token/index.ts` | `mintLlmToken` / `verifyLlmToken` (shared, HMAC-signed) |

### Chat Scopes

- `general` - inferred when no `collectionId` / `summaryId` is provided
- `collection` - inferred when `collectionId` is provided
- `document` - inferred when `summaryId` is provided

## Code Style

- **Formatter**: Biome with tab indentation, double quotes
- **Import organization**: Enabled via Biome
- **Path aliases**: `@/*` maps to `./src/*`

## Environment Variables

### chat-api

Required:
- `E2B_API_KEY` — required only when `SANDBOX_PROVIDER=e2b` (the default); not needed for the local provider
- `DAEMON_AUTH_TOKEN`
- `LLM_TOKEN_SECRET` — HMAC secret for minting per-turn tokens (shared with the gateway)
- `GATEWAY_PUBLIC_URL` — base URL of the merged gateway; the sandbox agent points BOTH the Claude binary (→ `/v1/messages`) and the `mymemo-docs` CLI (→ `/v1/documents/*`) at it. **Must be reachable from inside the E2B sandbox**

Optional:
- `LOG_LEVEL` (default: `info`)
- `PORT` (default: 3000)
- `SANDBOX_PROVIDER` (default: `e2b`) — `e2b` leases a fresh sandbox per turn; `local` targets a long-lived daemon container for the docker-compose E2E harness (`compose.yaml`). Selected in `sandbox-orchestration/singleton.ts`
- `LOCAL_SANDBOX_DAEMON_URL` (default: `http://sandbox:8080`) — base URL of the local daemon container (`SANDBOX_PROVIDER=local` only)
- `E2B_TEMPLATE` (default: `sandbox-template-dev`)
- `WORKSPACE_STORE_ROOT` — root dir of the durable workspace store (local filesystem `WorkspaceStore` adapter). Holds per-user/per-conversation work, output, and the docs manifest, plus per-run event logs, following the path model `users/{userId}/conversations/{conversationId}/…` and `users/{userId}/runs/{runId}/events.jsonl`. Defaults to `.workspace-store` under the process cwd (writable in the container). **For durability across container recycles, point this at a mounted persistent volume in production**

### gateway

Required:
- `ANTHROPIC_API_KEY` — the real provider key; lives **only** in this service
- `DATABASE_URL` — read-only connection to the MyMemo KB Postgres; the credential lives **only** in this service
- `LLM_TOKEN_SECRET` — must match chat-api's

Optional:
- `UPSTREAM_BASE_URL` (default: `https://api.anthropic.com`)
- `DB_PASSWORD` — spliced into `DATABASE_URL` when it is passwordless (the form the platform injects)
- `DB_SSL` (default: on; set `disable` for a local non-TLS Postgres)
- `GATEWAY_PORT` (default: 8080)
