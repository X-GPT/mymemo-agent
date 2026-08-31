# Chat API behavior

Use this guide when changing routes, validation, Run admission, history, Live Stream attachment, or artifact delivery. The AG-UI agent surface is mounted under `/v1` in `apps/chat-api/src/app.ts`.

A Conversation is the durable container, a Run serves one submitted message, and Downloadable artifacts are the Conversation's current published files.

## Routes and invariants

### Harness-hosted AI SDK chat path

The local-only composition mounts `POST /api/chat`. It accepts the strict
`useChat` body (`id`, one User message with one text part, `model`, `trigger`)
and, after identity, Conversation ownership (`404`), Archive (`409`), and
exposure (`403`) checks, runs one turn of Claude Code inside a Harness sandbox
(see [ADR-0033](../adr/0033-host-the-ai-sdk-chat-loop-in-a-vercel-sandbox-through-harnessagent.md)).
`HarnessAgent` runs in the chat-api process; each Conversation owns one
persistent Vercel Sandbox whose harness `sessionId` is the Conversation id. The
response is the AI SDK UI message stream (`toUIMessageStreamResponse()`),
forwarded unchanged: text arrives as it is produced and the model's reasoning
as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.

The route builds one `HarnessAgent` per turn through
`deps.createHarnessChatAgent(turn)`, a factory the local composition creates
once over the Claude Code adapter (`auth: 'direct'`, `ENABLE_TOOL_SEARCH=false`,
thinking at the adapter default), the Vercel sandbox provider, and a read-only
`pg` pool on `KB_DATABASE_URL`. The turn carries the *Harness turn* id (a UUID
minted per request), the owner and Conversation ids, the Conversation's frozen
Scope from its row, and the audit log. The agent's `activeTools` is
`HARNESS_ACTIVE_TOOLS` (`ai-chat/tools/harness-tools.ts`): the adapter's
common names `read`, `write`, `edit`, `grep` plus `HARNESS_TOOL_NAMES` —
`ListDocuments`, `SearchDocuments`, `LoadDocuments`, the document tools
chat-api executes itself. The appended `instructions` (`HARNESS_INSTRUCTIONS`)
tell the model which tools are real here; the bridge hardcodes the
`claude_code` preset, so this path appends to Claude Code's native prompt
rather than replacing it.

Tool calls arrive in two shapes. A built-in call arrives as the bridge's own
`tool-*` parts (`toolName` = the common name, `providerExecuted: true`, input
and result as Claude Code produced them; a built-in failure is Claude Code's
own error result); the only other `tool-*` parts with `providerExecuted: true`
are the bridge's synthetic `compaction` and `fileChange` parts (`dynamic:
true`). A document tool arrives as one `tool-input-available` and one
`tool-output-available` per call with `toolName` = the short name and
`providerExecuted: false`. A failed document tool is an ordinary
`tool-output-available` whose `output` is `{ error: "Error: …" }` — never a
`tool-output-error` or a stream error — so the turn continues and the model
can react; the route's `onError` scrubber is not on that path.

The document tools mirror the Run path's (`apps/agentcore-runtime/src/documents/`)
in description, schema, scope rules, and caps, which are code constants: 20
documents per `ListDocuments` page, 8 `SearchDocuments` results, 10 documents
per `LoadDocuments` call at 256 KiB each and 1 MiB per call. Scope is the
Conversation's frozen Scope, applied server-side before every query. Every
list, search, and per-document load appends one `document_access_events` row
through chat-api's writable agent-DB connection with `run_id` = the Harness
turn id (as on the Run path, a ten-document `LoadDocuments` call writes ten
rows), and every call logs one info line with the turn binding. `LoadDocuments` materializes each document to
`<work directory>/.mymemo/docs/<id>.md` through the restricted sandbox
session handed to `execute()` (`experimental_sandbox`; absolute paths, since
relative-path handling on the session is implementation-defined) and returns
the paths and byte counts, so the model can `Read` or `Grep` the file;
`ListDocuments` and `SearchDocuments` never touch the session. Tool outputs
are bounded only by those caps — every tool input and output, built-in or
document, is persisted verbatim in the sandbox's Claude transcript and
therefore in the snapshot. The two document-tool implementations are
deliberately separate (decided on #610); a boundary fix lands twice.

Claude's working directory is the harness session work directory, created
empty on the Conversation's first turn; the agent's `sandboxConfig.onSession`
hook hands its absolute path to `LoadDocuments` on fresh and resumed
sessions. Files there persist through the per-Conversation snapshot exactly
like the transcript, and vanish with it: Vercel's snapshot expiry and the
fresh-session fallback below discard the Conversation's files and cached
documents too. Nothing on this path touches E2B or
`conversation_runtime.sandbox_id`; the Run path's Workspace and the Harness
sandbox share no filesystem, so a Harness turn and a Run on one Conversation
are not serialized against each other.

Continuity between messages is the sandbox snapshot: after every turn —
drained, cancelled, or failed — the route calls `session.stop()` and stores the
returned opaque pointer in `conversation_runtime.harness_resume_state`; the
next turn passes it back as `createSession({ sessionId, resumeFrom })`. If
resuming throws, the route logs `harness session resume failed; starting a
fresh session` and starts a fresh session for the same id. Permanent deletion
nulls the pointer; retention and the rest of the lifecycle are ADR-0033's.

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
of Conversation ids in `ai-chat.route.ts`, checked and set in one synchronous
step before any sandbox work and released only after `session.stop()` has
settled — also on abort and on failure — so a resume can never overlap a stop.
It is correct only for the single-process local composition; the production
replacement (a leased marker on `conversation_runtime`) is deferred.

There is no admission, Run, history, or retry yet: those are follow-up slices
of [#595](https://github.com/X-GPT/mymemo-agent/issues/595).
The adapter runs the configured `OPENROUTER_DEFAULT_MODEL`; the request `model`
literal is validated, not forwarded. Production composition does not mount this
path; its `createHarnessChatAgent` throws.

Local two-turn recall check (real harness; needs the Compose stack with the
Vercel triple and `OPENROUTER_API_KEY` exported):

```sh
H='-H content-type:application/json -H x-member-code:m1 -H x-partner-code:p1'
ID=$(curl -s -X POST localhost:3000/v1/conversations $H -d '{}' | jq -r .conversationId)
turn() { curl -sN -X POST localhost:3000/api/chat $H -d "{\"id\":\"$ID\",\"model\":\"anthropic/claude-sonnet-5\",\"trigger\":\"submit-message\",\"messages\":[{\"id\":\"$2\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"$1\"}]}]}"; }
turn "Remember the word pelican." 11111111-1111-4111-8111-111111111111
docker compose restart chat-api
turn "Which word did I ask you to remember?" 22222222-2222-4222-8222-222222222222   # answer mentions pelican
```

Local two-turn file and document check (same stack and `turn` helper, with
`x-member-code:demo-member` — the member `apps/agentcore-runtime/db/init.sql`
seeds the KB for); turn 3 shows shell or web requests yield text only:

```sh
turn "Use your Write tool to create notes.md containing the word pelican, then use SearchDocuments to find a document about anything." 33333333-3333-4333-8333-333333333333 | tee /tmp/turn1.sse
grep '"toolName":"write"' /tmp/turn1.sse | grep -c '"providerExecuted":true'   # ≥ 1: it ran in the sandbox
grep -c '"toolName":"SearchDocuments"' /tmp/turn1.sse                          # ≥ 1: executed by chat-api
sleep 10   # stop() saves the resume pointer after the stream drains; restarting sooner loses it
docker compose restart chat-api
turn "Use your Read tool on notes.md and tell me the word. Then SearchDocuments again, LoadDocuments one result, and Grep the file it returns for its title." 44444444-4444-4444-8444-444444444444 | tee /tmp/turn2.sse
grep -c '"toolName":"read"' /tmp/turn2.sse                                      # ≥ 1; answer mentions pelican
grep -o '"toolName":"LoadDocuments"' /tmp/turn2.sse | head -1                   # present
grep -o '\.mymemo/docs/[^"]*\.md' /tmp/turn2.sse | head -1                      # the materialized path
grep -c '"toolName":"grep"' /tmp/turn2.sse                                      # ≥ 1: the cached copy was grepped in the sandbox
docker compose exec postgres psql -U mymemo -d mymemo_agent -c "select run_id, operation, result_count from document_access_events order by id"   # one row per call
turn "Run ls -la in your shell, then fetch https://example.com." 55555555-5555-4555-8555-555555555555 | tee /tmp/turn3.sse
grep -c '"type":"tool-' /tmp/turn3.sse       # 0
```

### Create a Conversation

`POST /v1/conversations` accepts the strict `CreateConversationBody` (`.strict()`) with optional `collectionId` and `summaryId`. It validates the body, resolves trusted identity, checks exposure admission, then persists the frozen Scope. Runtime selection is not public input and no runtime gate is consulted.

`InternalIdentity` comes from `X-Member-Code` and `X-Partner-Code`; `X-Team-Code`, `X-Member-Name`, and `X-Partner-Name` are optional. `memberCode` becomes the owner (`user_id`). The server generates the Conversation UUID.

Return `201 { conversationId, title, scope, createdAt, lastActivityAt, archivedAt }`. The same Conversation summary shape is returned by list and lifecycle routes. A new empty draft has `title: null` and `archivedAt: null`.

### Manage Conversations

`GET /v1/conversations` lists either the regular or archived partition with title search and activity-keyset pagination as `{ conversations, nextCursor }`. `PATCH /v1/conversations/:conversationId` renames or archives/unarchives while serializing Archive transitions with Run admission. `DELETE /v1/conversations/:conversationId` rejects active Runs and permanently deletes durable Conversation data.

All operations are owner-scoped. Missing and foreign Conversations both return `404`. These management routes bypass the new-work exposure gate.

The four lifecycle routes above (create, list, rename/Archive, permanent delete) also serve at `/v2/conversations` with identical semantics: one shared router (`conversation-lifecycle.route.ts`) is mounted under both prefixes. The Run, history, and artifact routes stay v1-only; the v2 data plane and the outbox-based deletion upgrade are separate tickets under spec #654.

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
