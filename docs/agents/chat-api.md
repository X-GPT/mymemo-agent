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
therefore in the snapshot. The chat path's handlers, scoped KB client, and
audit writer live in the shared `@mymemo/document-tools` package (#665), also
consumed by the v2 In-VM server; `ai-chat/tools/` keeps only the Harness
`ToolSet` adapter. That shared implementation remains deliberately separate
from the Run path's (decided on #610); a boundary fix lands twice.

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

The four lifecycle routes above (create, list, rename/Archive, permanent delete) also serve at `/v2/conversations` with identical semantics: one shared router (`conversation-lifecycle.route.ts`) is mounted under both prefixes. The Run and artifact routes stay v1-only; the rest of the v2 data plane and the outbox-based deletion upgrade are separate tickets under spec #654.

### Read v2 history

`GET /v2/conversations/:conversationId/messages` returns the durable UIMessage history over `conversation_messages` in ascending `sequence`, paged backwards from the newest page as `{ messages, nextCursor }` (`?limit` defaults to 50 and clamps to 100; `?before=<sequence>` is the cursor `nextCursor` hands back). A user message carries its Turn `status`/`startedAt`/`finishedAt` as UIMessage `metadata`; a Turn's single assistant message returns its stored parts verbatim (step and tool parts included) — an interrupted or error Turn shows exactly its completed Steps by the In-VM writer's commit-before-publish invariant. chat-api only reads here. Owner-scoped: missing and foreign Conversations return `404`; an empty history — every pre-v2 Conversation included — is an empty page; archived Conversations stay readable; the read bypasses the new-work exposure gate (v1 precedent).

### Submit a v2 message

`POST /v2/conversations/:conversationId/messages` submits one UIMessage and
answers with the stock AI SDK v7 UI Message Stream scoped to that message's
own Turn (spec #654, #667). The body is the stock `useChat` /
`DefaultChatTransport` request, `.strict()`: `id` (must equal the path
Conversation id), `trigger: "submit-message"`, and `messages`, of which only
the final one is submitted — it must be a user UIMessage with only text parts
(each ≤ 50,000 characters), and its client `id` becomes the Turn id, so it is
held to the path-safe Conversation-id shape (it names the Live Stream
channel). Earlier messages are the client's history and validation input, not
new durable history. `regenerate-message`, files, and message metadata are
rejected with `400`.

Order of operations: identity → `503` while MicroVM orchestration is not
configured (`MICROVM_IMAGE_ARN` and its companions) → exposure gate (`403`,
before any write, on every submission) → the `queued` INSERT under the
Conversation row lock (`404` for missing or foreign, `409` for an archived
Conversation — the lock is the one `PATCH` archive takes, so no message slips
in beside an Archive) → subscribe to the Turn's Live Stream lane (keyed on
Conversation id + message id: the message id is client-chosen and unique only
within its Conversation) → Ensure-VM (below) → relay. Subscribing before
Ensure-VM is what makes early chunks unlosable: the v2 lane keeps no backlog,
and a cold VM drains the queue the moment it boots. That INSERT is chat-api's only write to
`conversation_messages`; the In-VM server owns every status transition. There
is no `409` for concurrency: a second POST is simply the next queued row, and
its response holds with silent SSE comment keepalives (`: ping`, every 5 s)
while queued predecessors drain, then carries only its own Turn's chunks.

#### Ensure-VM (orchestration, #669)

chat-api drives the Conversation's MicroVM inline in the POST handler
(`features/conversation-vm/`); there is no orchestrator service and nothing
runs in the background. `conversation_vm` (one row per Conversation: VM id,
endpoint, image version, `launching | running | terminated`, last activity,
the Checkpoint pointer) is both the registry and the **transactional
launch claim**: one upsert inserts a fresh `launching` row or re-claims a
`terminated` one (lazy rehydrate) or a `launching` one older than 2 minutes
(the claimant died mid-launch), and returns a claim token to exactly one
caller. That caller alone mints the per-Conversation gateway token, composes the
`runHookPayload` (Conversation identity, agent DB, KB, and Redis URLs, the
`/v2/gateway/<conversation>` model URL and the `/v2/checkpoint/<conversation>`
door on `GATEWAY_BASE_URL`, the token, the model — ≤ 16 KB), calls `RunMicrovm` (AWS SDK adaptive retry, 5 attempts, the
egress connector, the managed ingress connector, the execution role, idle
policy 900 s / 3600 s / auto-resume, 8 h maximum duration), and records the
VM as `running` — a write fenced on its claim token, as is the release below,
so a launcher whose claim outlived the stale window and was re-claimed
cannot record over the newer claimant; it terminates the VM it just launched
instead. It does not nudge: the In-VM server's drain loop starts
inside the `/run` hook and consumes the queue itself. A launch that fails
after retries releases the claim (`terminated`, immediately re-claimable) and
answers `503` with `Retry-After: 5`; the Turn is durable, so the client's
re-POST is a no-op insert plus a fresh launch.

Every later POST finds the `running` row and **nudges** the VM through its
endpoint (`CreateMicrovmAuthToken` for port 8080, then `POST /nudge`; a
suspended VM auto-resumes under the platform, nothing resumes proactively).
A failed nudge asks `GetMicrovm`: `TERMINATED`, `TERMINATING`, or not found
marks the row `terminated` and re-runs Ensure-VM once, which re-claims and
launches onto the current image — the lazy rehydrate after an 8 h-cap kill or
a failed boot. Any other state (booting, suspending) keeps the row; the
queued Turn waits for the In-VM server's interval self-heal. A caller that
finds another's fresh `launching` claim does nothing: that VM's boot drains
the queue, this Turn included. Archive triggers nothing (the idle policy
winds the VM down); unarchive does nothing until the next message.

Resume never upgrades the image (snapshot restore), so upgrades land only at
rehydrate. `MICROVM_IMAGE_UPGRADE_URGENT=true` converts the next nudge of a
VM whose recorded image version differs from the image's latest active
version into terminate + rehydrate, once per Conversation.

The response is `200 text/event-stream` with the `x-vercel-ai-ui-message-stream: v1`
header, each chunk as one `data:` frame exactly as the In-VM server published
it (stock `UIMessageChunk` grammar, one assistant UIMessage per Turn), and a
`data: [DONE]` terminator after the Turn's terminal chunk (`finish` | `abort`
| `error` — the Outcome). A stock `useChat` needs no custom transport.
The keepalive tick doubles as a terminal watch: if two consecutive ticks find
the Turn durably terminal with no terminal chunk arrived (the publisher died;
a restarted VM sweeps it `interrupted` — one such read may only be the window
between the In-VM server's Outcome commit and its terminal publish), the
stream ends with `[DONE]` and no synthesized chunk. A relay failure mid-stream closes the response without `[DONE]` and
without synthesizing anything; a subscribe failure answers `503` after a
best-effort Ensure-VM so the queued Turn still runs. A nudge failure is
absorbed inside Ensure-VM and the response streams on — the row is durable
and the In-VM server's interval self-heal consults Postgres on its own. In
every case the client Recovers from durable history.

A re-POST of the same client message id creates no second Turn (the primary
key is the idempotency authority; the row's parts and status stay as they
were). If that Turn is still `queued` or `processing` the response attaches
to its Live Stream and nudges — chunks published before the re-POST are
missed, there being no backlog. If the Turn already reached its Outcome the
Live Stream is gone and the response is `410 { error: "Turn already ended",
recovery: "history" }`, the v1 history-recovery signal. A client id that
names an assistant message instead (those ids are visible in history) is
`409`; nothing is written.

Client disconnect never interrupts a Turn: chat-api drops its subscription
and nothing else; the Turn runs to its Outcome and the durable history has
it. Interruption is its own route, below.

Local check (the local composition only: `IN_VM_SERVER_URL` in
`apps/chat-api/local/index.ts` nudges one hand-started In-VM server instead
of orchestrating a MicroVM; the Compose Postgres + Redis, and chat-api with
the same identity):

```sh
H='-H content-type:application/json -H x-member-code:m1 -H x-partner-code:p1'
ID=$(curl -s -X POST localhost:3000/v2/conversations $H -d '{}' | jq -r .conversationId)   # the In-VM server's MYMEMO_CONVERSATION_ID
curl -sN -X POST localhost:3000/v2/conversations/$ID/messages $H -d "{\"id\":\"$ID\",\"trigger\":\"submit-message\",\"messages\":[{\"id\":\"m1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Say pelican.\"}]}]}"
curl -s localhost:3000/v2/conversations/$ID/messages $H | jq '.messages[-1]'   # the streamed assistant message, durably
```

### Interrupt a v2 Turn

`POST /v2/conversations/:conversationId/interrupt` stops the currently
`processing` Turn (spec #654, #668). There is no Turn id in the route: at
most one Turn processes. chat-api resolves that Turn's message id and hands
the nudge's one command, `{interrupt: messageId}`, to Ensure-VM, then
answers `202 { messageId }`. With nothing processing it answers `204` and does
nothing. Owner-scoped: missing and foreign Conversations return `404`; `503`
while MicroVM orchestration is not configured; a launch this request owned
and lost answers the same retryable `503` + `Retry-After: 5` as the message
POST. Like v1 interruption, the route bypasses the new-work exposure gate.

Delivery is Ensure-VM's (above) with the command as the nudge's JSON body: a
`running` VM receives it (auto-resuming if suspended); a VM the platform has
ended is retired and rehydrated instead, and the new VM's boot sweep
terminalizes the stale `processing` Turn `interrupted` — so a Turn whose VM
died still ends. A nudge that fails for any other reason is absorbed exactly
as on the message POST: the `202` means the command was handed to Ensure-VM,
not that the VM applied it — a Turn still running is the signal to retry.

Interruption intent is ephemeral — no control table, no flag, no write by
chat-api. Queued successors are never flushed: after the interruption the
next queued Turn serves normally.

In the In-VM server the command applies the SDK's `interrupt()` to the
processing Turn. If the target is still `queued` when the command arrives it
terminalizes `interrupted` directly, without ever running (`started_at` stays
NULL); it streamed nothing, so a client holding its message POST sees the
response end through the terminal watch rather than an `abort` chunk. This
route never produces that case — it names only a `processing` Turn, and a
Turn's status is monotonic — so the branch is the In-VM server's own guard
for any nudge caller naming a queued Turn (#668's race clause). Once
accepted, `interrupted` wins the Outcome whatever the SDK stream does next:
the Turn's SSE ends with the `abort` chunk and the assistant row keeps
exactly what had durably completed at that moment — Steps and tool results
streamed after the command, the truncated provider envelope included, are
neither persisted nor published. A command naming a Turn that is neither
queued nor in flight is dropped — including one that lands in the instant
between the claim's commit and the In-VM server learning of it. A retry
always re-sends the SDK control, so a control the CLI rejected is not lost
either; a command that reaches a claimed Turn before its model call starts
ends it `interrupted` without making that call.

Local check (same setup as the message POST above, with a prompt long enough
to still be streaming):

```sh
curl -sN -X POST localhost:3000/v2/conversations/$ID/messages $H -d "{\"id\":\"$ID\",\"trigger\":\"submit-message\",\"messages\":[{\"id\":\"m2\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Write a 2000-word essay about pelicans.\"}]}]}" &
sleep 3; curl -s -i -X POST localhost:3000/v2/conversations/$ID/interrupt $H   # 202 {"messageId":"m2"}; the stream above ends with {"type":"abort"}
curl -s localhost:3000/v2/conversations/$ID/messages $H | jq '[.messages[] | select(.role=="user")][-1].metadata.status'   # "interrupted"
curl -s -i -X POST localhost:3000/v2/conversations/$ID/interrupt $H   # 204: nothing processing
```

### Checkpoint a v2 Conversation

Durability across VM replacement (spec #654, #670). A Conversation's VM is
disposable — the platform's 8 h cap, an urgent image upgrade, and a failed
boot all end it, and the next message lazily rehydrates onto a fresh one.
What makes that invisible is the **Checkpoint**: the Agent session
(`~/.claude`, where the CLI keeps its transcripts, minus the `debug` and
`shell-snapshots` scratch) and the Workspace, packed by the In-VM server as
one gzipped tar (`apps/in-vm-server/src/checkpoint.ts`).

The VM has no network path to S3 (no VPC endpoint: that absence is the
egress lockdown), so the Checkpoint is **brokered through chat-api**
(`features/checkpoint/`): `PUT /v2/checkpoint/:conversationId` accepts it
and `GET` serves it, both authenticated by the per-Conversation gateway token
— the same one the model gateway verifies, now carrying
`{ conversationId, userId, exp }` so chat-api can address the
`conversation_vm` row by primary key. chat-api derives the Conversation from
the verified token and writes exactly
`conversations/<conversationId>/<uuid>.tar.gz` in the checkpoint bucket:
per-Conversation scoping in code, with no VM-side IAM at all (the VM
execution role carries no policy). `PUT` streams the body (Content-Length
required, 256 MiB cap) to a fresh key, then moves
`conversation_vm.checkpoint_pointer` to it in one write guarded on the VM
named in `x-mymemo-microvm-id` — a VM the row no longer names (retired by an
urgent upgrade while its suspend hook was still draining) gets `409` and its
object is removed, so a stale VM never forks the lineage — and deletes the
previous object best-effort. The pointer therefore always names a complete
object: the latest durable Checkpoint. `GET` streams the object the pointer
names, `204` when there is none (a fresh Conversation), `404` when the
pointer dangles (the VM then fails its boot rather than serve from nothing).
Unauthenticated or foreign tokens get the gateway's opaque `401`; `503`
while MicroVM orchestration is not configured.

In the VM the lifecycle hooks drive it. **`/suspend` is a graceful-drain
gate**: the drain loop is paused (no new claim), the hook holds while a Turn
is processing, and once the loop is parked with nothing in flight the full
Checkpoint is packed and `PUT`; only then does the hook answer 200, since the
platform snapshots right after and a suspended VM's termination fires no
hook. A failed `PUT` answers 500 and lifts the pause, so a VM the platform
keeps running keeps serving. **`/resume`** lifts the pause. **`/run`**
restores before anything else — the `GET`, the unpack into HOME and the
Workspace, then the boot sweep and the drain loop — so the VM is never ready
with stale state, and a restore that fails fails the launch (the client's
re-POST rehydrates again). Both hooks are registered with the platform's
60 s maximum (`scripts/deploy/register_microvm_image.sh`); a Turn that
outruns the suspend budget is snapshotted mid-Turn by the platform, and its
Checkpoint lands after resume, when the drain completes. A running VM's
terminate writes no Checkpoint: the suspend-time one is the durable one.

Model-side memory follows the Conversation because the Agent session id is
pinned: `agentSessionId(conversationId)` (a UUID v5 — the SDK requires a
UUID, a Conversation id need not be one) is the SDK `sessionId` of a fresh
session and the `resume` target whenever its transcript exists under
`~/.claude/projects/` — after a restore on a new VM, and after a retired
session within one process. The rehydrated VM's first model call replays
the earlier Turns' prompts and replies before the new one. A hard kill
mid-Turn (no hook) leaves that Turn `processing`; the replacement VM's boot
sweep terminalizes it `interrupted`, and history shows exactly the Steps
that had committed.

No local check: the hooks fire only in the MicroVM. The In-VM
`checkpoint.test.ts` round-trips a Checkpoint through a stand-in door over a
real socket, and `agent-session.test.ts` pins create-vs-resume.

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
