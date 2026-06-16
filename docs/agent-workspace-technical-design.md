# MyMemo Agent Workspace Technical Design

## Purpose

This document defines the target architecture for MyMemo's agent workspace system. It is written for coding agents and engineers who will evolve the current `chat-api`, `gateway`, `sandbox-daemon`, and document-access flow.

The key design is:

> Use E2B for untrusted agent execution, keep durable workspace state outside the sandbox, and route all LLM/document authority through the unified gateway. The gateway uses OpenRouter as the default LLM upstream so MyMemo can route to cheaper models without exposing provider credentials to the sandbox.

## Current Baseline

The current codebase is a Bun monorepo:

```text
apps/
  chat-api/          public/internal chat API and E2B orchestrator
  gateway/           unified OpenRouter-backed LLM proxy + scoped document DB reader
  sandbox-daemon/    daemon and agent bundle shipped into E2B
  mymemo-docs/       CLI used by the sandbox agent for document search/fetch

packages/
  llm-token/         HMAC signed bearer token shared by chat-api and gateway
```

Current behavior:

- `chat-api` creates a fresh E2B sandbox per turn.
- `chat-api` deploys `daemon.js` and `agent.js` into the sandbox.
- `sandbox-daemon` runs the Claude Agent SDK process.
- The agent calls the unified gateway for LLM traffic and document access.
- Target state: the gateway sends LLM traffic to OpenRouter by default, not directly to Anthropic.
- Documents are not materialized to the sandbox filesystem by default.
- The current document tool exposes separate `mymemo-docs search` and `mymemo-docs fetch`.
- The Claude Agent SDK emits a `sessionId`; this is an `agentSessionId`, not a product conversation id.

## Target Concepts

### `conversationId`

MyMemo-owned user-visible thread id.

Responsibilities:

- Groups user turns into one product conversation.
- Maps to the latest `agentSessionId`.
- Owns a durable conversation workspace.
- Survives sandbox recreation, provider changes, and agent session resets.

### `runId`

One backend agent execution attempt.

Responsibilities:

- Identifies one streamed execution.
- Tracks sandbox lease, tool calls, document hydration, final status, failure, retry, and audit events.
- Used for logs, SSE replay, cancellation, and debugging.

`runId` is close to a turn id, but it is intentionally execution-oriented. If a single user turn is retried, each retry can get a new `runId`.

### `agentSessionId`

Claude Agent SDK session id.

Responsibilities:

- Used internally to resume Claude SDK context.
- May span multiple runs in one conversation.
- Should not be the primary client-visible conversation id.

## Target Runtime Model

Use one logical workspace per user/conversation, but do not keep one physical sandbox running forever.

```text
logical workspace
  durable state in object storage / database

physical E2B sandbox
  created or reused only while active
  hydrated before a run
  synced after a run
  terminated after short idle window
```

Recommended lifecycle:

```text
1. Request arrives
2. chat-api creates runId
3. chat-api leases existing warm sandbox or creates a new one
4. chat-api hydrates conversation workspace into sandbox
5. sandbox-daemon runs agent
6. documents are searched remotely and hydrated locally on demand
7. chat-api/sandbox syncs changed files and manifests out
8. sandbox remains warm for a short idle window
9. sandbox is terminated on idle, version drift, health failure, or risk signal
```

Initial idle policy:

```text
active run: keep sandbox alive
0-5 minutes idle: keep warm
>5 minutes idle: sync and terminate
```

Tune this from real latency and cost data.

## Target Workspace Layout

Inside the sandbox:

```text
/workspace/
  system/
    daemon.js
    agent.js
    version.json

  conversations/
    {conversationId}/
      docs/
        manifest.json
        doc-{id}.md
      work/
        agent scratch files
      output/
        generated artifacts
```

Durable source of truth is outside the sandbox:

```text
workspace store
  users/{userId}/conversations/{conversationId}/work/
  users/{userId}/conversations/{conversationId}/output/
  users/{userId}/conversations/{conversationId}/docs/manifest.json
  users/{userId}/runs/{runId}/events.jsonl
```

The sandbox filesystem is a hydrated working copy, not the database.

## Document Access Model

The agent should have one document-facing operation:

```text
search_documents(query)
```

There should be no separate agent-facing `fetch_document`.

Internally, `search_documents` does:

```text
1. Search remote document index through the unified gateway
2. Rank candidates
3. Fetch selected top documents through the unified gateway
4. Write fetched documents to local sandbox disk
5. Update docs manifest
6. Return snippets plus local file paths
```

Example result:

```json
{
  "documents": [
    {
      "documentId": "doc_123",
      "source": "hydrated_from_remote",
      "title": "Acme Renewal Agreement",
      "snippet": "The renewal term starts...",
      "localPath": "/workspace/conversations/conv_123/docs/doc_123.md"
    },
    {
      "documentId": "doc_099",
      "source": "already_local",
      "title": "Prior Renewal Notes",
      "snippet": "Renewal was discussed...",
      "localPath": "/workspace/conversations/conv_123/docs/doc_099.md"
    }
  ]
}
```

### Agent Document Policy

Local documents are only the current working set. They are not proof that the whole corpus has been searched.

For open document questions:

```text
remote search is required by default
```

Use local files only when the user explicitly scopes the task to current files, already-loaded files, or a file just found.

Examples:

```text
"What are the renewal terms?"
  -> call search_documents

"Compare all renewal agreements"
  -> call search_documents, combine already-local and newly hydrated docs

"Summarize the Acme contract you just found"
  -> local-only is acceptable

"Continue editing the draft"
  -> local-only is acceptable
```

The agent prompt must state this policy explicitly.

## Unified Gateway Responsibilities

There is one deployed gateway service, with separate internal responsibilities.

```text
gateway
  auth/
  llm/
    providers/
      openrouter.ts
  documents/
  db/
```

LLM responsibilities:

- Verify bearer token.
- Enforce audience and expiry.
- Enforce model/header allowlists.
- Inject `OPENROUTER_API_KEY` only on upstream requests.
- Proxy sandbox LLM traffic to OpenRouter.
- Select cheaper/default models by gateway policy, run config, or environment.
- Preserve the sandbox-facing Claude Agent SDK compatibility surface where practical.

OpenRouter-specific responsibilities:

- Keep `OPENROUTER_API_KEY` only in the gateway environment.
- Configure OpenRouter base URL, default model, and optional routing/fallback preferences.
- Attribute cost and usage back to `userId`, `conversationId`, and `runId`.
- Normalize OpenRouter/provider errors into gateway errors that do not leak secrets.

Document responsibilities:

- Verify bearer token.
- Enforce user, conversation, run, scope, and expiry.
- Search private document DB.
- Fetch scoped document content.
- Enforce hydration limits.
- Audit every search and hydrated document.

The sandbox must never receive:

- `DATABASE_URL`
- DB password
- AWS credentials
- `OPENROUTER_API_KEY`
- direct provider API keys
- broad document credentials

## OpenRouter LLM Routing

The sandbox continues to point the Claude Agent SDK at the MyMemo gateway:

```text
ANTHROPIC_BASE_URL=<MYMEMO_GATEWAY_URL>
ANTHROPIC_AUTH_TOKEN=<short-lived llm_token>
ANTHROPIC_API_KEY=""
```

The gateway then calls OpenRouter upstream:

```text
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=<gateway-only secret>
OPENROUTER_DEFAULT_MODEL=<cheap/default model>
```

Do not send `OPENROUTER_API_KEY` to E2B, the daemon child agent, or the browser/tool runtime.

Provider selection should be centralized in the gateway:

```text
run policy / env
  -> choose OpenRouter model
  -> enforce allowlist and budget
  -> call OpenRouter
  -> stream normalized response to sandbox
```

Suggested config:

```text
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_DEFAULT_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_CHEAP_MODEL=google/gemini-flash-1.5
OPENROUTER_HTTP_REFERER=https://mymemo.example
OPENROUTER_APP_TITLE=MyMemo
```

The exact model names are deployment policy, not agent prompt policy. The agent should request capabilities; the gateway should decide which model is allowed and economical.

## Token Model

The current token is a single HMAC bearer token. Target state should separate audience and purpose.

Recommended claims:

```json
{
  "aud": "documents",
  "userId": "user_123",
  "conversationId": "conv_123",
  "runId": "run_456",
  "sandboxId": "sbx_789",
  "scope": "collection",
  "collectionId": "col_123",
  "exp": 1760000000000
}
```

Use at least audience enforcement:

```text
aud = "llm"
aud = "documents"
```

Prefer separate environment variables:

```text
ANTHROPIC_AUTH_TOKEN=<llm_token>
MYMEMO_DOC_TOKEN=<doc_token>
```

`ANTHROPIC_AUTH_TOKEN` here is the MyMemo short-lived token accepted by the gateway. It is not the OpenRouter API key.

Even with one deployed gateway, LLM and document paths should reject the wrong audience.

## Proposed `chat-api` Structure

Ignoring migration cost, prefer direct domain folders instead of `features/`:

```text
apps/chat-api/src/
  chat/
  runs/
  workspaces/
  sandboxes/
  documents/
  agent/
  routes/
  config/
  lib/
```

### `chat/`

External chat API behavior:

- Request schema and identity header validation.
- SSE stream setup.
- Client-facing event mapping.
- Chat controller.

### `runs/`

Backend execution attempts:

- Create `runId`.
- Track run lifecycle.
- Persist/replay run events.
- Support cancellation/retry.
- Coordinate workspace, sandbox lease, documents, and agent execution.

### `workspaces/`

Durable logical workspace:

- Restore workspace state into sandbox.
- Sync changed files out.
- Maintain workspace manifests.
- Interface with object storage.

### `sandboxes/`

E2B lifecycle:

- Create/reuse sandboxes.
- Maintain warm leases.
- Deploy daemon/agent bundles.
- Recycle on idle/version drift/health failure.
- Proxy turns to sandbox daemon.

### `documents/`

Document hydration policy:

- Decide hydration limits.
- Track visible documents per run/conversation.
- Maintain document manifests.
- Coordinate with gateway/daemon for `search_documents`.

### `agent/`

Agent-specific protocol:

- Build system prompts.
- Define tool instructions.
- Encode document-search policy.
- Track `agentSessionId`.

### `routes/`

HTTP route composition:

- Mount API versions.
- Keep Hono route setup thin.

### `config/`

Environment validation and normalization.

### `lib/`

Small generic utilities only. Do not put domain concepts here.

## Proposed `sandbox-daemon` Structure

```text
apps/sandbox-daemon/
  routes/
  agent/
  process/
  tools/
    search-documents.ts
  workspace/
    manifest.ts
    hydrate.ts
```

Responsibilities:

- Expose `/turn`, `/health`, `/current`.
- Spawn the Claude Agent SDK process.
- Provide agent tools.
- Implement `search_documents` orchestration if it lives inside the daemon.
- Write hydrated docs to local disk.
- Maintain sandbox-local manifest.

## Proposed Gateway Structure

```text
apps/gateway/src/
  auth/
    bearer.ts
    claims.ts
  llm/
    routes.ts
    proxy.ts
    policy.ts
    providers/
      openrouter.ts
  documents/
    routes.ts
    search.ts
    hydrate.ts
    policy.ts
  db/
    client.ts
    queries.ts
  server.ts
  env.ts
```

Keep one deployable service, but avoid one large `index.ts`.

## Major Gaps From Current Code

1. Current code creates and kills a fresh sandbox per turn.
2. There is no sandbox lease manager or warm idle policy.
3. There is no durable workspace store or sync manifest.
4. `mymemo-docs` exposes separate `search` and `fetch`.
5. The agent prompt instructs manual search then fetch.
6. Documents are not hydrated to local disk as first-class local paths.
7. There is no `conversationId` or `runId`.
8. The Claude SDK `sessionId` is exposed as `sessionId`; it should be treated as `agentSessionId`.
9. Tokens do not include `aud`, `conversationId`, or `runId`.
10. Gateway code is unified as a deployable service but still should be split internally.
11. Gateway currently needs an OpenRouter provider adapter and model policy to support cheaper-model routing.

## Implementation Order

1. Add `conversationId`, `runId`, and `agentSessionId` terminology.
2. Add run state and event persistence.
3. Add sandbox lease abstraction while preserving current fresh sandbox behavior behind the interface.
4. Add workspace manifest and local path conventions.
5. Replace agent-facing `mymemo-docs search/fetch` with `search_documents`.
6. Implement search -> internal fetch -> local hydration -> manifest update.
7. Update prompt policy so open document questions always search remote corpus.
8. Add token audiences and split document/LLM tokens.
9. Add warm reuse and idle termination.
10. Add OpenRouter provider adapter and model allowlist/budget policy in the gateway.
11. Split gateway internals into LLM/document/auth modules.

## Non-Goals

- Do not give sandbox direct database access.
- Do not copy the full user corpus into the sandbox by default.
- Do not treat local docs as the complete corpus.
- Do not use Claude SDK `sessionId` as `conversationId` or `runId`.
- Do not make Fargate the default runtime unless AWS-native control becomes more important than E2B's agent sandbox abstraction.
- Do not expose `OPENROUTER_API_KEY` to the sandbox, daemon child agent, client, or document tools.
