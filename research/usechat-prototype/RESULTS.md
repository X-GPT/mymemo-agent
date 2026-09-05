# Prototype #726 — useChat against the #723 contract through mymemo-service

Run 2026-09-05 on this Mac. Three throwaway branches, all named `prototype/usechat-front`:

- **mymemo-agent** — `research/usechat-prototype/front/server.ts`: a Hono stub of the Lambda front implementing the [#723](https://github.com/X-GPT/mymemo-agent/issues/723) contract verbatim (8 routes, scripted UIMessage chunks, in-memory state, 5 s "S3 Files export lag"). `bun run research/usechat-prototype/front/server.ts` → :3010. `.claude/launch.json` starts all three servers.
- **mymemo-service** — `POST/GET /agent/conversations/{id}/messages` relayed like the v1 run routes (+ the `x-vercel-ai-ui-message-stream` header on the SSE relay). Run with `COMPAT_LEGACY_LOGIN_ENABLED=true HZ_TOKEN=x GZ_API_KEY=x CHAT_SESSION_LOCK_ENABLED=false MYMEMO_AGENT_CHAT_API_URL=http://localhost:3010 uv run --frozen uvicorn src.main:app --port 3002` (in-memory auth, no DB/Redis).
- **mymemo-web** — route `/agent-proto/:conversationId?` → `src/views/agent-conversation/react/proto/AgentProtoReact.tsx`: `useChat` (`@ai-sdk/react` 4.0.96, `ai` 7.0.83) with `DefaultChatTransport` + `prepareSendMessagesRequest` mapping to `{ text, requestId }`. `pnpm local` → :3000, "dev login" button.

Path under test: browser → Vite proxy → mymemo-service (business token, identity headers) → stub front.

## Results

| Check (from the ticket) | Result | Evidence |
|---|---|---|
| submit → stream renders tokens | **pass** | `status=streaming`, text deltas visible mid-Turn; `start-step`/tool parts render as they arrive |
| catalog payload renders | **pass** | `data-generative-ui` part rendered by the real `generativeUiComponentRegistry.table` component (validate → persist → emit: the part is in history after reload) |
| artifact part lists / downloads | **pass** (after revision 1) | `data-artifacts` part renders; `GET artifacts` lists `report.md`; `download-url` → 409 `not_exported_yet` inside the 5 s lag, then `{ downloadUrl }`; the presigned-style URL downloads with `Content-Disposition: attachment` |
| second submit during a Turn → 409, UI copes | **pass with a client rule** (finding 2) | server: 409 `processing { turnId }` (direct + through mymemo-service). `useChat` itself does **not** serialise `sendMessage`: without a client gate the SDK appended the message, the 409 was swallowed when the first stream ended, and the assistant card was duplicated. With `send` disabled while `status ∈ {submitted, streaming}` the UI is clean |
| reload mid-Turn shows history only | **pass** | reload 6 s into a 22 s Turn: user + assistant with `status: "processing"` and the committed Steps; reload after end: `status: "done"`, `processing` cleared by the "Runtime" even though the first stream reader had gone |
| Archive / rename / list recency / search | **pass** | rename → list shows the title; `search=` substring works; Archive moves the item to the archived list and `send` → 409 `archived`; unarchive restores |
| delete | **pass** | item leaves the list; the URL then 404s on history and artifacts |
| duplicate `requestId` retry | **pass** | resend with the same id → 409 `duplicate_request { turnId, status }`, shown; "reload history" shows the Turn |
| error Turn | **pass** | `error { errorText: "internal_error" }` after step 1 → `useChat` `status=error`, `error.message` = the code, partial message kept, history `status: "error", errorCode: "internal_error"` |
| Lambda/reader gone mid-Turn | **pass** | curl `head` cut the stream; history later showed the Turn `done` (the stub keeps draining) |

## Findings fed back to the contract (#723)

1. **Artifact field names.** The contract renamed v1's `sizeBytes` → `size` and dropped `createdAt`; mymemo-web's existing `parseArtifactList` requires `sizeBytes` (number) and the panel stayed empty. **Revision: keep v1's `Artifact = { artifactId, path, sizeBytes, contentType, createdAt, updatedAt }`.** The stub now emits that shape.
2. **Client gate on `useChat.status`.** The 409 `processing` is the server backstop, but the AI SDK (`ai` 7) does not queue or reject a second `sendMessage` while a response is active — it corrupts local state. **Revision: the contract states that the client must not submit while `status` is `submitted` or `streaming`; the 409 covers races only.**
3. **SSE relay header.** mymemo-service's `_event_stream_headers` copies only `content-type`, `cache-control`, `x-accel-buffering`; the prototype adds `x-vercel-ai-ui-message-stream`. `DefaultChatTransport` parsed the stream either way, so this is hygiene, not a blocker — the BFF change list for the cutover should include it.
4. **Auth-failure envelope.** mymemo-service answers a missing business token with HTTP 200 `{ code: 401, … }`; a `useChat` transport must treat a non-200 business `code` as an error (the prototype does; the existing AG-UI client already does).
5. **User message ids.** The client mints its own user-message id; history returns `u_<turnId>`. Harmless because the prototype replaces messages wholesale from history; the rebuild should do the same rather than merge by id.

## Not exercised

Real Runtime, DynamoDB, Statsig gate (the stub has none), token budget / `abandoned` (needs a 12-minute wait), `quota_exceeded`, mymemo-service on ECS with SigV4 to a Function URL (the BFF change is the same code path).
