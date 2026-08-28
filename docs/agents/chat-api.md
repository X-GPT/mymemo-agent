# Chat API behavior

Use this guide when changing routes, validation, Run admission, history, Live Stream attachment, or artifact delivery. The AG-UI agent surface is mounted under `/v1` in `apps/chat-api/src/app.ts`.

A Conversation is the durable container, a Run serves one submitted message, and Downloadable artifacts are the Conversation's current published files.

## Routes and invariants

### Harness-hosted AI SDK chat path

The local-only composition mounts `POST /api/chat`. It accepts the strict
`useChat` body (`id`, one User message with one text part, `model`, `trigger`)
and, after identity, Conversation ownership (`404`), Archive (`409`), and
exposure (`403`) checks, runs one turn of Claude Code with every built-in tool
disabled inside a Harness sandbox (see [ADR-0033](../adr/0033-host-the-ai-sdk-chat-loop-in-a-vercel-sandbox-through-harnessagent.md)).
`HarnessAgent` runs in the chat-api process; each Conversation owns one
persistent Vercel Sandbox whose harness `sessionId` is the Conversation id. The
response is the AI SDK UI message stream (`toUIMessageStreamResponse()`),
forwarded unchanged: text arrives as it is produced and the model's reasoning
as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.

The route builds one `HarnessAgent` per turn through
`deps.createHarnessChatAgent(tools)`, a factory the local composition creates
once over the Claude Code adapter (`auth: 'direct'`, `ENABLE_TOOL_SEARCH=false`,
thinking at the adapter default) and the Vercel sandbox provider. The agent's
`activeTools` is `HARNESS_TOOL_NAMES` (`ai-chat/tools/harness-tools.ts`) — the
short names of the chat-api-hosted Harness tools, and nothing else — so no
Claude built-in is callable in the sandbox; the list is empty until the first
Harness tool lands. Asked to run a command or read a file, the model produces
text only: nothing executes and no tool part is streamed (see the built-ins-off
check below for what that text looks like). The only `tool-*` parts with
`providerExecuted: true` are the bridge's
own synthetic `compaction` and `fileChange` parts (`dynamic: true`). The
appended `instructions` (`HARNESS_INSTRUCTIONS`) tell the model it has no
filesystem, memory directory, or built-in tools of its own; the bridge
hardcodes the `claude_code` preset, so this path appends to Claude Code's
native prompt rather than replacing it.

Continuity between messages is the sandbox snapshot: after every turn —
drained, cancelled, or failed — the route calls `session.stop()` and stores the
returned opaque pointer in `conversation_runtime.harness_resume_state`; the
next turn passes it back as `createSession({ sessionId, resumeFrom })`. If
resuming throws, the route logs `harness session resume failed; starting a
fresh session` and starts a fresh session for the same id. Permanent deletion
nulls the pointer; retention and the rest of the lifecycle are ADR-0033's.

Each Harness turn also attaches to the Conversation's E2B **Workspace**
without a Run (ADR-0033 stage 2). Before the session is created the route reads
`conversation_runtime` fresh and runs connect-or-create
(`ai-chat/tools/harness-workspace.ts`): `sandbox_id` set → `Sandbox.connect`,
which auto-resumes a paused sandbox; unset, or connect throws → `Sandbox.create`
from `WORKER_E2B_TEMPLATE` with `lifecycle.onTimeout = 'pause'` and
`{ userId, conversationId }` metadata, then `sandbox_id` is repointed with the
same unfenced `(user_id, conversation_id)` upsert as the resume pointer
(`harness-runtime-store.ts` holds both). The idle window is granted once at
connect/create as `HARNESS_SANDBOX_TIMEOUT_MS`. Nothing on this path takes
Conversation Ownership, renews the sandbox, records an orphan, or reads or
writes `sandbox_tainted`. Consequences: a sandbox created but not recorded (a
DB failure between create and upsert) idle-pauses on its own with no orphan
record, and a stop whose process-tree kill could not be confirmed reconnects
to the same sandbox on the next turn. A Run replacing the sandbox between turns
needs no handling — the row is read fresh every turn. The Workspace handle is
the Harness tools'; until they land nothing uses it.

Stop is best-effort and has no endpoint or durable record: the request's own
abort signal is passed to the turn, so `useChat().stop()` or a disconnect
aborts Claude Code in the sandbox, the stream ends with the AI SDK `abort`
part, and no error reaches the client. A turn that fails to start returns the
generic `500`; a turn that fails while streaming ends with the AI SDK `error`
part carrying only the generic `"An error occurred."` text. Failure details
are logged by chat-api and never sent to the client.

Two messages cannot drive one Conversation's sandbox at once. While a turn is
in flight, a second `POST /api/chat` for the same Conversation returns
`409 { error: "Conversation has an active response" }` and the first turn is
unaffected; other Conversations are unaffected. The guard is a process-local set
of Conversation ids (`ai-chat/harness-turns.ts`), checked and set in one
synchronous step before any sandbox work and released only after
`session.stop()` has settled — also on abort and on failure — so a resume can
never overlap a stop. A Run and a Harness turn refuse each other through the
same set: `POST /api/chat` returns `409 { error: "Conversation has an active
Run" }` while the Conversation has an Active Run, and Run admission returns
`409 { error: "Conversation has an active response" }` while a Harness turn is
in flight, so two executors never drive one Workspace. Both guards are correct
only for the single-process local composition; the production replacement (a
leased marker on `conversation_runtime`) is deferred.

There is no admission, Run, history, or retry yet: those are follow-up slices
of [#595](https://github.com/X-GPT/mymemo-agent/issues/595).
The adapter runs the configured `OPENROUTER_DEFAULT_MODEL`; the request `model`
literal is validated, not forwarded. Production composition does not mount this
path; its `createHarnessChatAgent` throws.

Local two-turn recall and Workspace-reuse check (real harness; needs the
Compose stack with the Vercel triple, `OPENROUTER_API_KEY`, and `E2B_API_KEY`
exported):

```sh
H='-H content-type:application/json -H x-member-code:m1 -H x-partner-code:p1'
ID=$(curl -s -X POST localhost:3000/v1/conversations $H -d '{}' | jq -r .conversationId)
turn() { curl -sN -X POST localhost:3000/api/chat $H -d "{\"id\":\"$ID\",\"model\":\"anthropic/claude-sonnet-5\",\"trigger\":\"submit-message\",\"messages\":[{\"id\":\"$2\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"$1\"}]}]}"; }
sbx() { docker compose exec -T postgres psql -U mymemo -d mymemo_agent -Atc "select sandbox_id from conversation_runtime where conversation_id = '$ID'"; }
turn "Remember the word pelican." 11111111-1111-4111-8111-111111111111; sbx
docker compose restart chat-api
turn "Which word did I ask you to remember?" 22222222-2222-4222-8222-222222222222; sbx   # answer mentions pelican; same sandbox_id
```

Local built-ins-off check (same stack and `turn` helper): a request for shell
or file work produces no `tool-*` part of any kind, nothing executes, and the
model's reasoning arrives as `reasoning-*` parts:

```sh
turn "Run ls -la in your shell and show me the output, then read /etc/hostname." 33333333-3333-4333-8333-333333333333 | tee /tmp/turn.sse
grep -c '"type":"tool-' /tmp/turn.sse        # 0
grep -o '"type":"reasoning-[a-z]*"' /tmp/turn.sse | sort -u   # reasoning-start, reasoning-delta, reasoning-end
```

The text is a refusal ("I don't have access to shell commands … here") in some
runs but not all: with no tool listed, the `claude_code` preset's own tool
guidance can lead the model to narrate a tool call as text
(`<bash>ls -la</bash>`) and invent its output — seen in one of two runs even
with `HARNESS_INSTRUCTIONS` forbidding it. That is model text, not a tool part,
and the pinned guarantee is the stream shape above; the refusal is expected to
settle once a real Harness tool is listed, as it did on the #612 spike.

### Create a Conversation

`POST /v1/conversations` accepts the strict `CreateConversationBody` (`.strict()`) with optional `collectionId` and `summaryId`. It validates the body, resolves trusted identity, checks exposure admission, then persists the frozen Scope. Runtime selection is not public input and no runtime gate is consulted.

`InternalIdentity` comes from `X-Member-Code` and `X-Partner-Code`; `X-Team-Code`, `X-Member-Name`, and `X-Partner-Name` are optional. `memberCode` becomes the owner (`user_id`). The server generates the Conversation UUID.

Return `201 { conversationId, title, scope, createdAt, lastActivityAt, archivedAt }`. The same Conversation summary shape is returned by list and lifecycle routes. A new empty draft has `title: null` and `archivedAt: null`.

### Manage Conversations

`GET /v1/conversations` lists either the regular or archived partition with title search and activity-keyset pagination as `{ conversations, nextCursor }`. `PATCH /v1/conversations/:conversationId` renames or archives/unarchives while serializing Archive transitions with Run admission. `DELETE /v1/conversations/:conversationId` rejects active Runs and permanently deletes durable Conversation data.

All operations are owner-scoped. Missing and foreign Conversations both return `404`. These management routes bypass the new-work exposure gate.

### Admit and stream a Run

`POST /v1/conversations/:conversationId/runs` strictly validates one standard `RunAgentInput` and requires `threadId` to equal the owned Conversation id. Reject client Tools, state, and forwarded authority.

`admitAgUiRun` is the only admission path. It atomically writes the client-supplied `runId`, the final plain-text User message, `run_started`, and the Run-keyed AgentCore dispatch outbox row under the Conversation lifecycle lock. Exact retries reattach to the same logical Run without another dispatch; mismatched reuse returns `409`. Admission commits before Redis access. Backpressure uses the explicit Active Run count under the same Conversation row lock.

Do not reintroduce the removed `runs_one_active_per_conversation` partial unique index as an implicit backpressure mechanism.

The original POST and `GET /v1/conversations/:conversationId/runs/:runId/events` both attach to the producer-buffered Live Stream and emit standard AG-UI JSON in data-only SSE frames. Every attach receives the full backlog and live tail; ignore `Last-Event-ID`. If no producer answers, retry while Postgres reports the Run active and keep SSE open with keepalives.

The AgentCore Runtime publishes standard `RUN_STARTED`, Assistant text lifecycle, Tool lifecycle, and terminal events. Redis stores no stream content; permanent Assistant messages, Tool activity, and Outcomes commit before their matching completion events are published.

A relay failure before the first event returns retryable `503`. A later failure closes the incomplete stream without synthesizing a protocol event. A terminal Run returns the `410` history-recovery signal instead of attaching.

### Interrupt a Run

`POST /v1/conversations/:conversationId/runs/:runId/interrupt` is the canonical durable interruption path. A queued Run becomes `interrupted`; a running or already `interrupt_requested` Run becomes or remains `interrupt_requested`. Both return `202 { runId, status }`, and a retry after interruption wins returns `202 { status: "interrupted" }`.

A `done` or `error` Run returns `409`. Missing and foreign Runs return the same owner-safe `404`. Interruption bypasses the new-work exposure gate.

### Read history and artifacts

`GET /v1/conversations/:conversationId/history` returns owner-scoped permanent history, paged as complete Runs with standard AG-UI messages and a separate terminal event. Postgres remains authoritative after the Live Stream ends or fails.

`GET /v1/conversations/:conversationId/artifacts` lists the current Downloadable artifact set. `GET /v1/conversations/:conversationId/artifacts/:artifactId/download-url` returns `{ downloadUrl }` with a fresh five-minute S3 URL. Both verify Conversation ownership and bypass the new-work exposure gate.

## Scopes

Scope is resolved once at Conversation creation and never changes:

- `general`: neither `collectionId` nor `summaryId` was provided
- `collection`: `collectionId` was provided
- `document`: `summaryId` was provided; it takes precedence over `collectionId`
