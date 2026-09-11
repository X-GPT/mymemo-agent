# v3 event and stream contracts: Managed Agents session events and the AI SDK resumable `ChatTransport`

**Research date: 2026-09-03.** Resolves
[#704](https://github.com/X-GPT/mymemo-agent/issues/704) for the
[v3 chat map (#701)](https://github.com/X-GPT/mymemo-agent/issues/701). Baseline under
review: the v3 design doc §5.2, §22, §25 on
[`research/v3-design-doc`](https://github.com/X-GPT/mymemo-agent/blob/research/v3-design-doc/docs/research/v3-claude-managed-agent-aws-architecture-2026.md)
(cited as `doc §N`).

Versions read: `ai` **7.0.83** (the workspace pin in
[`apps/chat-api/package.json`](../../apps/chat-api/package.json),
[`apps/in-vm-server/package.json`](../../apps/in-vm-server/package.json),
[`packages/live-text/package.json`](../../packages/live-text/package.json); published
2026-08-26; type definitions and runtime read from the installed
`ai@7.0.83/dist/index.d.ts` + `dist/index.js`, `@ai-sdk/provider-utils@5.0.32`);
npm `latest` at research time is `ai` **7.0.91** (published 2026-09-02) and
`@ai-sdk/react` **4.0.94**, whose `ChatTransport` source on `vercel/ai@main`
([chat-transport.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat-transport.ts))
is textually the same interface as 7.0.83. Managed Agents docs carry no version; all are
gated by the `managed-agents-2026-04-01` beta header.

Each claim is tagged **[documented]** (stated by a primary source), **[code]** (read from
the installed SDK or this repo), **[inferred]** (a consequence the sources do not state),
or **[unknown]**.

---

## 1. Claude Managed Agents session events

Source pages: [Session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming),
[Reference › Event types](https://platform.claude.com/docs/en/managed-agents/reference#event-types),
[API › List Events](https://platform.claude.com/docs/en/api/beta/sessions/events/list),
[API › Stream Events](https://platform.claude.com/docs/en/api/beta/sessions/events/stream),
[API › Get Session](https://platform.claude.com/docs/en/api/beta/sessions/retrieve),
[Webhooks](https://platform.claude.com/docs/en/managed-agents/webhooks).

### 1.1 Model

- Communication is event-based: you **send** `user.*` and `system.message` events; you
  **receive** session, span, and agent events. Persisted types follow `{domain}.{action}`;
  the stream-only preview events `event_start` / `event_delta` are the exception.
  [documented — events-and-streaming § Event types]
- Endpoints: `POST /v1/sessions/{id}/events` (send, batch of events),
  `GET /v1/sessions/{id}/events/stream` (SSE), `GET /v1/sessions/{id}/events` (history,
  cursor-paginated with `next_page`, `order` asc/desc by `processed_at`, `types[]`
  filter, `created_at[gt|gte|lt|lte]` filters "compared against the event's
  `processed_at`"). [documented — API List Events]
- **Every persisted event carries `id`, `type`, `processed_at`.** On events you send,
  `processed_at` is `null` while queued behind earlier events; `user.define_outcome`,
  `user.custom_tool_result`, `user.tool_result` are "processed on receipt and echoed
  back with `processed_at` already populated". [documented]
- There is **no numeric sequence field** on events. Order is `processed_at` order (the
  list endpoint sorts by it); the only per-event identity is the `sevt_…` `id`.
  [documented + inferred: the object schemas in List Events show no sequence/cursor field]
- Session `status` enum: `rescheduling | running | idle | terminated`. [documented — Get Session]
- Webhook names differ from stream names: `session.status_run_started` (every transition
  to `running`), `session.status_idled`, `session.budget_reached`, etc. [documented — Webhooks]

### 1.2 Full taxonomy

| Domain | Types | Notes |
|---|---|---|
| User (sent) | `user.message`, `user.interrupt`, `user.custom_tool_result`, `user.tool_confirmation`, `user.define_outcome`, `user.tool_result` | `user.tool_result` is self-hosted-only: "your integration is responsible for providing `agent_toolset` results". |
| System (sent) | `system.message` | Privileged context for the accompanying turn and after; model-gated. |
| Agent | `agent.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`, `agent.mcp_tool_use`, `agent.mcp_tool_result`, `agent.custom_tool_use`, `agent.thread_context_compacted`, `agent.thread_message_received`, `agent.thread_message_sent` | Content may include `{"type":"redacted"}` blocks. |
| Session | `session.status_running`, `session.status_idle`, `session.status_rescheduled`, `session.status_terminated`, `session.deleted`, `session.updated`, `session.error`, `session.usage`, `session.thread_created`, `session.thread_status_running`, `session.thread_status_idle`, `session.thread_status_rescheduled`, `session.thread_status_terminated` | |
| Span | `span.model_request_start`, `span.model_request_end` (carries `model_usage`), `span.outcome_evaluation_start/ongoing/end` | Observability markers; `span.model_request_end` is also the preview-closing signal (§1.4). |
| Deltas (stream-only) | `event_start`, `event_delta` | Never persisted; opt-in per connection. |

[documented — Reference › Event types]

### 1.3 Payload shapes the design leans on

All from [API › List Events](https://platform.claude.com/docs/en/api/beta/sessions/events/list) object schemas. [documented]

| Event | Fields |
|---|---|
| `user.message` | `id`, `type`, `content[]` (text / image / document / redacted blocks), `processed_at` |
| `user.interrupt` | `id`, `type`, `processed_at` (null until applied) |
| `agent.message` | `id`, `type`, `content[]` (text or redacted blocks only), `processed_at` — **no model, no stop reason, no usage** on the event |
| `agent.thinking` | `id`, `type`, `processed_at` — "a progress signal, not a content carrier" |
| `agent.tool_use` | `id`, `name`, `input` (map), `evaluated_permission?` (`allow`/`ask`/`deny`), `session_thread_id?`, `processed_at` |
| `agent.tool_result` | `id`, `tool_use_id` (= the `agent.tool_use` event id), `content?[]` (text/image/document/search_result), `processed_at` — **no status / duration fields** |
| `session.status_running` | `id`, `type`, `processed_at` — **no run id / attempt** |
| `session.status_idle` | `id`, `processed_at`, `stop_reason` ∈ `{type:"end_turn"}` \| `{type:"requires_action", event_ids[]}` \| `{type:"retries_exhausted"}` \| `{type:"budget_reached"}` |
| `session.error` | `id`, `error` (typed union; every variant has `message` + `retry_status` ∈ `retrying`/`exhausted`/`terminal`), `processed_at` |
| `session.usage` | `id`, `usage` (cumulative snapshot: tokens, cache, `list_cost`, `active_seconds`, `server_tool_use`), `budget` (or null), `processed_at`; emitted "on idle transitions rather than on a timer", always immediately before `session.status_idle` |
| `session.status_terminated` | `id`, `type`, `processed_at` — **no reason / terminatedBy** |
| `event_start` | `{type:"event_start", event:{type, id}}` — no top-level id |
| `event_delta` | `{type:"event_delta", event_id, delta:{type:"content_delta", index, content:{type:"text", text}}}` |

Tool call ids: the `agent.tool_use` **event id** is the tool-use id (`tool_use_id` on
the result, `tool_use_id` on `user.tool_confirmation`, `stop_reason.event_ids` on idle).
[documented — Tool confirmation walkthrough]

### 1.4 Ordering, deltas vs durable events, reconnect

- Per model request, a turn that completes normally emits, in order: one
  `session.status_running` opens the turn; then per request
  `span.model_request_start` → `event_start` → `event_delta`… → buffered `agent.message`
  → `span.model_request_end`. [documented — § Accumulate and reconcile]
- Deltas are a **best-effort preview**: "the buffered `agent.message` is always the
  authoritative record. A client that ignores previews still receives a complete, correct
  stream." Guarantees: concatenating a preview's deltas keyed by `(event_id, index)` "gives a
  prefix of `content[index].text`" (deltas "might be shed under load"); a connection emits
  at most one `event_start` per `event_id`; the buffered event is the last thing delivered
  for that id; `span.model_request_end` still arrives when the buffered event never does
  (error/interrupt). [documented]
- `agent.thinking` previews are start-only (no deltas, no content). Previews are
  thread-scoped and text-only (never tool use/results). [documented — § Limitations]
- **No replay of deltas on reconnect**: "Deltas are delivered only to the connection that
  opted in, while it is open … a connection opened after a model request started receives
  no deltas for that in-flight event." [documented]
- Stream semantics: "Only events emitted after the stream is opened are delivered, so
  open the stream before sending events." Reconnect procedure: open a new stream, list the
  full history to seed a set of seen event ids, tail the live stream skipping ids already
  seen. The stream has **no cursor / `Last-Event-ID` resume**; dedupe is by `id`.
  [documented — § Streaming events]
- SSE framing: the doc examples parse only `data:` lines carrying one JSON event each; no
  `event:` or `id:` SSE fields are shown or documented. [inferred from examples]
- Interrupt: `user.interrupt` returns once queued; a model response in progress stops
  immediately, tool calls may delay it; the interrupted turn ends with
  `session.status_idle` whose `stop_reason` is **`end_turn`** — "there is no stop reason
  specific to interruption". [documented]
- Tool confirmation / custom tools pause the session with `stop_reason: requires_action`
  + `event_ids[]`; resolving fewer than all "re-emits `session.status_idle` with the
  remainder". [documented]
- Budget: pause arrives as `session.thread_status_idle(budget_reached)` per thread →
  `session.usage` → `session.status_idle(budget_reached)`; at the cap only
  settle-in-flight events are accepted, `user.message` is a 400. [documented]

### 1.5 Self-hosted sandbox worker protocol

Sources: [Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes),
[API › Environments Work](https://platform.claude.com/docs/en/api/beta/environments/work),
[Reference › Self-hosted worker](https://platform.claude.com/docs/en/managed-agents/reference#self-hosted-worker),
[AWS: Lambda MicroVMs as a sandbox for Claude Managed Agents](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html).

- Anthropic keeps the agent loop and the model; a `self_hosted` environment "acts as a
  work queue": a session assigned to it is enqueued as a **work item**; your worker
  claims it, spawns an execution context, downloads skills, runs tool calls, posts results.
  "Tool inputs and outputs still flow to Anthropic's control plane." [documented]
- Work item (`BetaSelfHostedWork`): `id` (`work_…`), `data:{type:"session", id}`,
  `state` ∈ `queued | starting | active | stopping | stopped`, `secret` ("populated when
  polling for work; null on all other retrieval paths"), `acknowledged_at`,
  `latest_heartbeat_at`, `started_at`, `stop_requested_at`, `stopped_at`, `metadata`.
  The claimed item does **not** carry session metadata; the worker fetches
  `GET /v1/sessions/{id}` for it. [documented]
- Endpoints (all "called automatically by the pre-built environment worker"):
  `GET …/work/poll` (`block_ms` 1–999, `reclaim_older_than_ms` default 5000 — "reclaim
  unacknowledged work items older than this"), `POST …/work/{id}/ack` ("transitioning it
  from 'queued' to 'starting' and removing it from the queue"),
  `POST …/work/{id}/heartbeat` ("maintain the lease"; optional
  `expected_last_heartbeat` for optimistic concurrency — literal `NO_HEARTBEAT` claims an
  unclaimed lease, mismatch → 412; response has `lease_extended`, `state`,
  `ttl_seconds`), `POST …/work/{id}/stop` (`force` → `stopped` immediately; otherwise
  `stopping`, the worker "notices on its next lease heartbeat, cancels the session's
  in-flight tool call, and confirms"), `GET …/work` (list), `POST …/work/{id}` (metadata
  patch), `GET …/work/stats` (`depth`, `pending`, `oldest_queued_at`, `workers_polling`
  = pollers in last 30 s; "Uses Redis Stream consumer group metrics"). [documented]
- The lease TTL value (`ttl_seconds`) and heartbeat cadence are not stated. [unknown]
- Two claim patterns: always-on poller, or webhook-triggered handler waking on
  `session.status_run_started`. Sandbox-per-session: the poller (`ant beta:worker poll
  --on-work` or SDK `work.poller()` with `autoStop:false`) injects `ANTHROPIC_SESSION_ID`,
  `ANTHROPIC_WORK_ID`, `ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_ENVIRONMENT_KEY`
  (+ `ANTHROPIC_WORK_SECRET` via stdin JSON) into the sandbox, which runs
  `EnvironmentWorker.handleItem()` and owns the stop call. The environment key, never the
  org API key, goes to the worker host. A session with no worker "stays queued rather
  than failing". Worker host needs `/bin/bash` at that exact path; the TS SDK needs
  Node 22+, `unzip`, `tar`. [documented]
- Custom tools served from the sandbox: agent emits `agent.custom_tool_use`, the worker
  posts `user.custom_tool_result` (SDK worker only). [documented]
- AWS reference: one MicroVM per session, launched by a Lambda on the
  `session.status_run_started` webhook via `RunMicroVM`; "Your code on the MicroVM claims
  the session, executes tool calls … in `/workspace`, and posts results back"; the org
  key "never reaches AWS compute" (Secrets Manager reference to the environment key);
  idle policy `suspendedDurationSeconds: 0`, `autoResumeEnabled: false`,
  `maximumDurationInSeconds` ≤ 28,800. [documented — AWS page]

### 1.6 Where doc §25.1 diverges from Managed Agents

doc §22 already states Managed Agents is "only a reference protocol" — v3 runs the Claude
Agent SDK and never receives these events. The list below is what §25.1 borrows that the
real protocol does **not** have, so the spec knows which fields are v3's own inventions.

| doc §25.1 | Managed Agents | Divergence |
|---|---|---|
| Envelope `sequence`, `runId`, `producer`, `correlationId`, `causationId`, `idempotencyKey`, `fencingToken` (§5.2) | Events carry only `id`, `type`, `processed_at` (+ type-specific fields); order = `processed_at` | All of these are v3-local. Fine, but a client must not expect them from Managed Agents shapes. |
| `session.created` | Not an event type; creation is the session object | v3-only. |
| `agent.message` payload "`messageId`, model, stopReason" | `id`, `content[]` only; model usage lives on `span.model_request_end`, cost on `session.usage` | v3 adds model/stopReason; MA keeps them on span/usage events. |
| `agent.tool_result` "`status`, `outputRef/error`, `durationMs`" | `tool_use_id`, `content?[]` only; no status/duration | v3-only fields. |
| `agent.tool_use` "`toolUseId`" separate from event id | The tool-use id **is** the `agent.tool_use` event `id` | Design should pick one identity; MA has no second id. |
| `session.status_running` "`runId`, attempt" | No fields | v3-only. |
| `session.status_idle` "`stopReason: end_turn`" | `stop_reason` is an object union: `end_turn` / `requires_action{event_ids}` / `retries_exhausted` / `budget_reached` | Design lists only `end_turn`; `retries_exhausted` maps to v3's recovery-failed outcome. |
| `session.error` "errorCode, retryable, sanitizedMessage" | typed `error` with `message` + `retry_status` ∈ retrying/exhausted/terminal | Same intent, tri-state not boolean. |
| `session.status_terminated` "reason, terminatedBy" | No fields | v3-only. |
| `user.interrupt` "`targetRunId`, reason" | No fields; interrupted turn ends `end_turn` | v3-only; note MA has no interrupted stop reason (v2 uses `abort`, §3). |
| `agent.thinking` "phase/progress marker; no reasoning body" | Same | Matches. |
| Missing from §25.1 | `session.status_rescheduled`, `agent.thread_context_compacted`, `span.model_request_start/end`, `session.deleted/updated` | Consider `span.*`-style markers for usage-per-request (design puts usage on `ResultMessage` only). |
| §25.4 preview "`event_start` / `event_delta`" | Same names; MA's delta is `{event_id, delta:{index, content:{text}}}`; previews are never persisted, never replayed | Matches in spirit; MA's guarantee list (§1.4) is a good template for the Redis Stream lane's contract. |
| §22 reconnect: cursor + replay | MA: no cursor; reconnect = list history + dedupe by id; deltas never replayed | v3 promises more than MA does (fine, but it is v3's own promise to keep). |

---

## 2. AI SDK UI Message Stream Protocol and `ChatTransport`

Source pages: [Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol),
[Transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport),
[Streaming Custom Data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data),
[Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams),
[`useChat()` reference](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat);
installed `ai@7.0.83` (`dist/index.d.ts` for types, `dist/index.js` for behaviour — the
`Chat` class is in `ai`, `@ai-sdk/react`'s `useChat` is a thin wrapper).

### 2.1 Version the contract is written for

- Repo pin: `ai@7.0.83` (all three consumers). The matching React hook package is
  `@ai-sdk/react@4.0.86` (it pins `ai: 7.0.83` exactly; `4.0.87` → `7.0.84`,
  `4.0.94` → `7.0.91`). `@ai-sdk/vue@4.0.91` pins `ai: 7.0.91`. [code — npm registry]
- `UIMessageChunk`, `ChatTransport`, `UI_MESSAGE_STREAM_HEADERS` in 7.0.83 match the
  docs' current descriptions and `main`'s `chat-transport.ts`. The design's typical wire
  output (doc §22.2) is valid 7.0.83. [code]

### 2.2 `ChatTransport` interface (exact, `ai@7.0.83` `index.d.ts` l.5322)

```ts
interface ChatTransport<UI_MESSAGE extends UIMessage> {
  sendMessages: (options: {
    trigger: 'submit-message' | 'regenerate-message';
    chatId: string;
    messageId: string | undefined;   // id to regenerate, else undefined
    messages: UI_MESSAGE[];
    abortSignal: AbortSignal | undefined;
  } & ChatRequestOptions) => Promise<ReadableStream<UIMessageChunk>>;
  reconnectToStream: (options: {
    chatId: string;
    abortSignal?: AbortSignal;
  } & ChatRequestOptions) => Promise<ReadableStream<UIMessageChunk> | null>;
}
```

`ChatRequestOptions` = `{ headers?, body?, metadata? }`. `reconnectToStream` returns `null`
when "no active stream exists" (the stock HTTP transport maps a **204** to `null`, any
other non-OK to a thrown error, and GETs `${api}/${chatId}/stream` unless
`prepareReconnectToStreamRequest` overrides). [code + documented]

The doc's transport page points custom-transport authors at `DefaultChatTransport`,
`HttpChatTransport` and the interface source; there is no other documented contract.
`DirectChatTransport.reconnectToStream()` always returns `null`; `WorkflowChatTransport`
(`@ai-sdk/workflow`) is the only stock transport with cursor-style reconnection
(`initialStartIndex`, GET `{api}/{runId}/stream`). [documented — Transport]

### 2.3 `UIMessageChunk` vocabulary and required ids (`index.d.ts` l.2293, `uiMessageChunkSchema`)

| Chunk | Required | Optional | Notes |
|---|---|---|---|
| `start` | — | `messageId`, `messageMetadata` | `messageId` sets the assistant message id (§2.5). |
| `start-step` / `finish-step` / `reset-step` | — | — | `reset-step` drops parts since the last `start-step`. |
| `text-start` / `text-delta` / `text-end` | `id` (+ `delta`) | `providerMetadata` | Part id must be unique within the message. |
| `reasoning-start` / `-delta` / `-end` | `id` (+ `delta`) | `providerMetadata` | |
| `tool-input-start` | `toolCallId`, `toolName` | `providerExecuted`, `dynamic`, `title`, `toolMetadata` | |
| `tool-input-delta` | `toolCallId`, `inputTextDelta` | | |
| `tool-input-available` | `toolCallId`, `toolName`, `input` | same as start | Creates the tool part if no start was seen. |
| `tool-input-error` | `toolCallId`, `toolName`, `input`, `errorText` | | |
| `tool-approval-request` | `approvalId`, `toolCallId` | `reason`, `isAutomatic`, `signature` | |
| `tool-approval-response` | `approvalId`, `approved` | `reason`, `providerExecuted` | |
| `tool-output-available` | `toolCallId`, `output` | `preliminary`, … | Requires a prior tool part with that id (§2.5). |
| `tool-output-error` | `toolCallId`, `errorText` | | |
| `tool-output-denied` | `toolCallId` | | |
| `data-*` | `data` | `id`, `transient` | Same `type`+`id` ⇒ in-place update; `transient` ⇒ `onData` only, never in `parts`. |
| `source-url` / `source-document` / `file` / `reasoning-file` / `custom` | per schema | | |
| `error` | `errorText` | | |
| `finish` | — | `finishReason` ∈ stop/length/content-filter/tool-calls/error/other, `messageMetadata` | |
| `abort` | — | `reason` | |
| `message-metadata` | `messageMetadata` | | In the schema, not on the docs page. |

[code; docs page lists the same set minus `message-metadata`/`tool-input-error`]

### 2.4 SSE wire

- `UI_MESSAGE_STREAM_HEADERS` = `content-type: text/event-stream`, `cache-control: no-cache`,
  `connection: keep-alive`, `x-vercel-ai-ui-message-stream: v1`, `x-accel-buffering: no`.
  The docs require the `x-vercel-ai-ui-message-stream: v1` header from custom backends.
  [code + documented]
- Frames: `data: <JSON chunk>\n\n`; terminator `data: [DONE]`. The stock parser
  (`parseJsonEventStream` in `@ai-sdk/provider-utils`) **drops `[DONE]` and ignores SSE
  `id:` / `event:` fields** — only `data` is read; the stream also ends cleanly when the
  body closes without `[DONE]`. SSE comment lines (`: ping`) are ignored by the parser.
  [code]
- Consequence for doc §22.3 (Redis entry id in SSE `id:`): the stock transport never sees
  it; a custom transport must parse SSE itself (or wrap the response body and read `id:`
  before handing chunks to `useChat`). [inferred]

### 2.5 `useChat` / `Chat` behaviour (`ai@7.0.83` `dist/index.js`, `AbstractChat.makeRequest`, `processUIMessageStream`)

- **Resume creates an empty message.** For `trigger: "resume-stream"` (and regenerate)
  the streaming state starts as `{ id: generateId(), role: "assistant", parts: [] }` —
  the local partial message is *not* used as the base. A `start` chunk with `messageId`
  overrides the id; on every write the message **replaces the last local message if the
  ids match, otherwise it is pushed** as a new message. [code l.18640–18700, 6861–6876, 7454]
  - ⇒ Replaying a Turn from its first chunk with the **same `assistantMessageId`** is
    idempotent (in-place replace). [inferred from the above]
  - ⇒ A different/absent `messageId` on resume yields a duplicate assistant message.
- **Chunks that reference unknown ids throw.** `text-delta`/`text-end` for an `id` with no
  `text-start` in *this* stream, `reasoning-*` likewise, and any `tool-output-*` /
  `tool-approval-*` for a `toolCallId` with no tool part in the message throw
  `UIMessageStreamError`; the request ends in `status: "error"` with `onError`. [code
  l.7070–7090, 6902–6925]
  - ⇒ **Cursor-continue (doc §22.4 priority 1 — "从 cursor 继续") cannot feed raw
    post-cursor chunks into `useChat`**: any `text-delta` whose `text-start` predates the
    cursor is fatal. The transport must either replay from the message's first chunk
    (design option 2) or synthesize the prefix (`start` + `text-start` + accumulated
    `text-delta` + tool parts) before the tail. [inferred]
- **No dedupe of chunks.** A re-delivered `text-delta` appends again. Exactly-once (or
  full-replay-from-`start`) is the server's job. [code — no id bookkeeping beyond part ids]
- **`abort` chunk is inert on the client.** `processUIMessageStream` has no `abort` case;
  the chunk passes through, state is untouched, and the stream ending sets
  `status: "ready"` (parts keep `state: "streaming"` on open text parts). `finish` only
  records `finishReason` / metadata; neither `start` nor `finish` is mandatory. [code]
- **`error` chunk** → `onError(new Error(errorText))` thrown inside processing →
  `status: "error"`; already-received parts stay. [code l.7481]
- **`stop()`** aborts pending preparations, the active resume request, and the active
  response; the request resolves with `isAbort: true`, `status: "ready"`. The server is
  not told. The resume-streams docs: "client-side aborts are treated as disconnects …
  `stop()` only closes the current HTTP connection and should not cancel the underlying
  generation" — add a dedicated stop endpoint that persists the partial message, cancels
  work, clears the active stream, and ignore stale stops by `activeStreamId`. [code + documented]
- **`onFinish`** receives `{ message, messages, isAbort, isDisconnect, isError, finishReason }`;
  `isDisconnect` is a heuristic (`TypeError` whose message contains "fetch"/"network"). [code + documented]
- **`resume: true`** in `useChat` calls `resumeStream()` once on mount (React `useEffect`
  on `[resume]`); `resumeStream()` = `makeRequest({trigger:"resume-stream"})`, which calls
  `transport.reconnectToStream`; `null` → `status: "ready"` silently; a newer resume aborts
  an older one. [code — `packages/react/src/use-chat.ts` l.234, `index.js` l.18570–18610]
- **Transient data parts** are only visible through `onData`; persistent `data-*` parts
  with an `id` reconcile in place. [documented + code l.7503]
- **`status`** ∈ `submitted | streaming | ready | error`; `messages` mutate through a serial
  job executor, so chunk application is ordered. [documented + code]

### 2.6 The documented resume pattern

[Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams) [documented]:

- Storage is yours: "Redis to store the UIMessage stream", a record of which stream is
  active per chat (`activeStreamId`), "Two API endpoints: POST to create streams, GET to
  resume them", and the `resumable-stream` package.
- POST: `createUIMessageStreamResponse({ stream, consumeSseStream })` — the callback
  tees the SSE bytes into `createNewResumableStream(streamId, () => stream)`, and
  `saveChat({ activeStreamId })`. GET `/api/chat/[id]/stream`: 204 when no active stream,
  else `resumeExistingStream(activeStreamId)` with `UI_MESSAGE_STREAM_HEADERS`.
- "Multiple clients can connect to the same stream simultaneously"; streams expire after
  a configurable time; clear `activeStreamId` when starting a new stream "to prevent
  resuming outdated streams".
- The resumed stream is the **whole** stored SSE stream from its start (that is what makes
  §2.5's empty-message resume work); there is no documented cursor on the stock path.
  [inferred — the docs never mention partial replay]

### 2.7 Where doc §22 diverges from the AI SDK contract

| doc §22 | AI SDK 7.0.83 | Divergence |
|---|---|---|
| §22.1 `sendMessages` = POST (202 + ids) then GET the run SSE | Interface allows it; the stock transport does one POST whose body is the stream | Custom transport required — as the doc says. `useChat` sends `messages` (full local list) + `trigger` + `messageId`; the transport picks the last user message. |
| §22.1 `reconnectToStream` "looks up the active Run; `null` if none" | Same semantics; stock maps 204 → `null` | Matches. Reconnect fires only on `resume: true` mount or explicit `resumeStream()`; **there is no automatic mid-stream reconnect** in `useChat` (only `WorkflowChatTransport` does that). |
| §22.3 SSE `id:` = Redis entry id, client stores cursor | Stock parser discards `id:`; custom transport must parse SSE | Design must state that the transport owns SSE parsing. |
| §22.4 priority 1: continue from cursor | Unknown-id chunks throw; resume state has empty parts | **Cannot work as written.** Either always replay from the Run's first chunk with the same `assistantMessageId` (priority 2 — this is also what v1 AG-UI attach and mymemo-web do today, §3/§4), or have the transport synthesize the prefix from a snapshot. |
| §22.4 priority 2: "remove the local incomplete assistant message, replay from `0-0`" | Same-id replay **replaces** the last message in place; removal is unnecessary | Simplify: no local removal step. |
| §22.2 `abort` chunk for a cancelled Run | `abort` is inert client-side; `useChat` shows `ready` with parts still `streaming` | Acceptable, but the spec should say what the persisted message looks like after `abort` (v2 uses `abort` as the interrupted Outcome, §3). |
| §22.2 `data-run-status`, `data-sandbox-status` as transient parts via `onData` | Supported (`transient: true`) | Matches. |
| §22.5 disconnect ≠ cancel; explicit `POST /runs/<runId>/cancel` | Matches the resume-streams guidance verbatim (stop endpoint, ignore stale stops, no stop from route cleanup) | Matches. |
| §5.4 stable `assistantMessageId`, part ids, `toolCallId` across replay | Required by §2.5 (replace-by-id; unknown ids throw) | Matches — and it is load-bearing, not a nicety. |

---

## 3. In-repo prior art (v2 and v1)

- **v2 relay** — [`packages/live-text/src/turn-live-stream-relay.ts`](../../packages/live-text/src/turn-live-stream-relay.ts):
  "Pure pub/sub — deliberately no producer-buffered backlog and no request/reply
  re-attach. The Live Stream dies with its Turn; a late or disconnected subscriber
  recovers from durable history, never from this lane." Per-Turn Redis channel keyed on
  Conversation id + message id; chunks validated against the stock `uiMessageChunkSchema`
  (`ai@7.0.83`); terminal chunk (`finish` | `abort` | `error`) latches the publisher —
  exactly one per Turn; 32 KiB per-event cap
  ([`live-stream-events.ts`](../../packages/live-text/src/live-stream-events.ts)). The
  Redis transport ([`redis-live-stream-relay.ts`](../../packages/live-text/src/redis-live-stream-relay.ts))
  is `PUBLISH`/`SUBSCRIBE`, not Streams — nothing here gives v3 the §22.3 `XADD`/`XREAD`
  lane; it would be new code. [code]
- **v1 relay** ([`live-stream-relay.ts`](../../packages/live-text/src/live-stream-relay.ts),
  AG-UI) is *producer-buffered*: every attach "receives the full backlog and live tail;
  ignore `Last-Event-ID`" ([docs/agents/chat-api.md](../agents/chat-api.md)). That is the
  replay-from-start model §2.5 requires; the buffer lives in the producer process, not Redis.
  [code + docs]
- **SDK → UIMessage mapper** — [`apps/in-vm-server/src/turn-stream-mapper.ts`](../../apps/in-vm-server/src/turn-stream-mapper.ts):
  one assistant `UIMessage` per Turn; each provider call is a Step (`start-step` on
  `message_start`, `finish-step` after committing the completed blocks on `message_stop`);
  text/reasoning part ids are mapper-local `blk_<n>` counters (**not stable across a
  re-run of the mapper** — a v3 replay must replay the recorded chunks, not re-map);
  `toolCallId` = the SDK `tool_use` block id; `tool-input-available` is emitted from the
  completed `assistant` block, never from deltas; `result` → `finish`
  (`messageMetadata: {status:"done"}`) or `error`; `abort` is published by the interrupt
  path. Subagent traffic (`parent_tool_use_id !== null`) is dropped. [code]
- **v2 route** — [`conversation-messages.route.ts`](../../apps/chat-api/src/features/conversation-messages/conversation-messages.route.ts):
  stock `useChat` POST body (`{ id, trigger: "submit-message", messages[] }`, last message
  = the Turn), `UI_MESSAGE_STREAM_HEADERS`, `data:` frames, `: ping` every 5 s doubling
  as a terminal watch, `data: [DONE]` after the terminal chunk, `410 { recovery:
  "history" }` for a re-POST of an ended Turn, a client disconnect never interrupts.
  v2 has **no `reconnectToStream` endpoint**; recovery = reload durable history. [code]

## 4. mymemo-web (separate repo)

Read from the local checkout `~/code/mymemo/mymemo-web` at `a68c7e8` (2026-08-22,
`main`; may lag the remote). [code]

- **mymemo-web does not depend on the AI SDK at all**: `package.json` has no `ai`,
  `@ai-sdk/*` package; `grep` finds no `useChat` import. The map's premise
  "mymemo-web is a separate repo on stock `useChat`" is **not true of this checkout**.
- Its agent chat (`src/views/agent-conversation/`) speaks **AG-UI**: `@ag-ui/client`
  0.0.57 `HttpAgent` to `POST /agent/conversations/:id/runs` (submit) and the run events
  GET (resume — "a resume replays the whole Run"), plus `POST …/runs/:runId/interrupt`;
  rendering via `@assistant-ui/react-ag-ui` 0.0.53 inside a Vue 3 app with React 19
  islands. Its interruption/replay accumulator (`runs.ts`) already encodes
  "committed text survives reconnects; a partial replay cannot un-commit".
- The legacy chat (`src/api/chat-sse.ts`) uses `sse.js` 2.7.1 against mymemo-service
  `chat/v3/agent` with bespoke named SSE events (`status`, `answer_chunk`,
  `reasoning_chunk`, `tool_call`, `citations`, `end`, …).
- **Open question for the prototype ticket**: the v3 client contract targets
  `useChat` + a custom `ChatTransport`; adopting it in mymemo-web means adding
  `@ai-sdk/react` (or `@ai-sdk/vue`) + `ai` and replacing the AG-UI island, or keeping
  AG-UI and translating on the server. Which AI SDK line to pin (7.0.83 to match the
  agent repo vs `latest` 7.0.91) is a prototype decision; both share the interface.

## 5. Open unknowns

1. Managed Agents lease TTL (`ttl_seconds`) and heartbeat cadence for self-hosted work items — not stated. [unknown]
2. Whether the Managed Agents SSE stream sets `id:`/`event:` fields — only `data:` is documented/shown. [unknown]
3. mymemo-web remote `main` may be ahead of the local `a68c7e8` checkout; AI SDK adoption status there is unverified beyond this snapshot. [unknown]
4. `@ai-sdk/vue` `resume` behaviour was not read (only `@ai-sdk/react`'s `useEffect`); assumed equivalent since both delegate to `ai`'s `Chat`. [inferred]
5. Whether v3 replays from `start` (one Redis Stream read from `0-0`) or synthesizes a prefix from a DynamoDB partial snapshot is a design decision this note only constrains (§2.7). [design]

## 6. Sources

- https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- https://platform.claude.com/docs/en/managed-agents/reference#event-types
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- https://platform.claude.com/docs/en/managed-agents/webhooks
- https://platform.claude.com/docs/en/api/beta/sessions/events/list
- https://platform.claude.com/docs/en/api/beta/sessions/events/stream
- https://platform.claude.com/docs/en/api/beta/sessions/retrieve
- https://platform.claude.com/docs/en/api/beta/environments/work
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html
- https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
- https://ai-sdk.dev/docs/ai-sdk-ui/transport
- https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data
- https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
- https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat
- https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat-transport.ts
- https://github.com/vercel/ai/blob/main/packages/react/src/use-chat.ts
- Installed `ai@7.0.83` (`dist/index.d.ts`, `dist/index.js`), `@ai-sdk/provider-utils@5.0.32` (`dist/index.js`); npm registry metadata for `ai`, `@ai-sdk/react`, `@ai-sdk/vue`
- Repo: `packages/live-text/src/*.ts`, `apps/in-vm-server/src/turn-stream-mapper.ts`, `apps/chat-api/src/features/conversation-messages/conversation-messages.route.ts`, `docs/agents/chat-api.md`
- mymemo-web local checkout `a68c7e8`: `package.json`, `src/api/chat-sse.ts`, `src/views/agent-conversation/runs.ts`
