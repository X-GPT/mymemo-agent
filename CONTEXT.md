# MyMemo Agent

The MyMemo agent runtime: a chat service where each Conversation is served by
its own AWS Lambda MicroVM running the Claude Agent SDK, with the untrusted
model-driven tools confined inside the VM by a process trust boundary.
Decided on ADR-0034; built to Spec #654.

## Language

**Conversation**:
The durable, user-visible container for a chat. Its document scope is frozen
at creation and never changes for its lifetime.
_Avoid_: chat, session, thread

**Conversation title**:
The persisted, user-visible label of a Conversation. It is initialized from
the first admitted user message when still unset, then changes only through an
explicit rename.
_Avoid_: summary, generated response

**Conversation activity**:
The most recent successfully admitted user message, or Conversation creation
when no message has been admitted. It determines list recency; rename and
Archive are not Conversation activity.
_Avoid_: metadata update, Turn completion

**Archive**:
A reversible lifecycle change that removes a Conversation from the default
Conversation list and prevents it from receiving new messages, without deleting
the Conversation or its history. Archiving triggers no orchestration: the
Conversation's VM winds down on its own idle policy.
_Avoid_: delete, close

**Permanent deletion**:
The irreversible end of a Conversation that removes it and makes its history
inaccessible. A Conversation with a processing Turn cannot be permanently
deleted. The deleting transaction also records the cleanup of the
Conversation's VM and Checkpoint, which completes asynchronously.
_Avoid_: Archive, soft delete

**Scope**:
The set of documents a conversation may access — `general`, `collection`, or
`document`. Resolved once at conversation creation, then only ever re-read.
_Avoid_: permissions, access level

**Execution runtime**:
The per-Conversation AWS Lambda MicroVM that serves a Conversation's Turns —
one VM per Conversation, never shared across tenants, persistent across turns
via the platform's suspend/resume, replaced by rehydration from the Checkpoint.
_Avoid_: AgentCore (retired), worker, sandbox (the VM is the runtime)

**In-VM server**:
The trusted MyMemo process inside the Execution runtime. It alone holds the
data-plane credentials (agent DB, KB DB, Redis), runs the Claude Agent SDK
`query()`, serves the document tools as in-process MCP, drains Turns from
Postgres, publishes the Live Stream, checkpoints state, and answers the
lifecycle hooks. The Claude Code CLI it spawns receives a credential-free
environment; that process boundary is the trust boundary.
_Avoid_: bridge (the Harness-era word), agent loop (ambiguous)

**Turn**:
The processing of one admitted user message by the Conversation's In-VM
server: statuses `queued → processing → done | error | interrupted`, carried
on the user-message row itself — the row is the Turn record. A Turn executes
at most once and is never re-run; the VM's single drain loop is the
serializer, so Turns run one at a time in submission order with no separate
admission machinery. A second submission while one is processing simply
queues.
_Avoid_: Run (the v1 term), request, job

**Nudge**:
The idempotent authenticated call from chat-api to the In-VM server meaning
"consult Postgres now". It wakes a suspended VM, triggers draining, and may
carry the one command — `{interrupt: messageId}` — targeting the processing
or a queued Turn. It carries no message content; the work bus is Postgres.
_Avoid_: dispatch, invoke

**Outcome**:
The single way a Turn ends: `done`, `error`, or `interrupted`, recorded as the
user-message row's terminal status. One word per outcome at every layer.
_Avoid_: completed, failed, finished, succeeded

**Interruption**:
A user request to stop the currently processing Turn, delivered as the nudge's
interrupt command and applied via the SDK's `interrupt()`. It targets one Turn
by message id, never flushes queued Turns, and wins the Turn's Outcome once
accepted. Intent is ephemeral — a lost interrupt is retried by the user, and
the durable fact is the Turn's `interrupted` status. Client disconnect never
interrupts.
_Avoid_: cancellation, abort (the SDK-internal mechanism), Run interruption

**Live Stream**:
The per-Turn sequence of UIMessage events published by the In-VM server over
Redis pub/sub and relayed by any chat-api task to the submitting client's SSE
response, scoped to that client's own Turn. Text deltas exist only here; a
Step's parts commit to Postgres before its completion chunk, and the Turn's
terminal chunk follows the final commit. There is no backlog protocol and no
mid-Turn re-attach: the Live
Stream dies with its Turn, and a disconnected client Recovers from durable
history.
_Avoid_: retained stream, replay cursor, Conversation history

**Assistant text delta**:
A bounded, provisional fragment of Assistant text on the Turn's Live Stream
before the provider response completes. Never persisted as a delta row; may
disappear when the Live Stream ends.
_Avoid_: durable message, token

**Recovering**:
Replacing a Turn's provisional client state with the durable history after its
Live Stream becomes unusable. The only post-disconnect story; nothing
re-attaches mid-Turn.
_Avoid_: Reconnecting (the deleted v1 concept), resuming

**Conversation history**:
The durable, user-visible record of a Conversation: the UIMessage rows of
`conversation_messages`, read in `sequence` order with cursor paging, each
user message carrying its Turn status as metadata. An interrupted or error
Turn retains exactly what durably completed — the completed Steps of the
Turn's Assistant message, never provisional text, no fabricated failure
results.
_Avoid_: thread history, Agent session, transcript, Run history

**Assistant message**:
The Turn's single model-authored UIMessage, accumulating every provider
response as Steps (step boundaries and tool parts embedded as parts).
Maintained by the In-VM server as one row, upserted at each Step's completion
boundary; its final commit precedes the Turn's terminal chunk on the Live
Stream.
_Avoid_: provider response (that is a Step), token stream

**Step**:
One provider call within a Turn, delimited on the Live Stream by
`start-step`/`finish-step` and embedded in the Assistant message as parts. The
durability boundary: a Step's parts commit before its completion chunk
publishes; an interrupted or error Turn retains exactly its completed Steps.
_Avoid_: turn (a Turn spans Steps), message

**Agent session**:
The Claude SDK transcript carrying a Conversation's model-side memory across
Turns. Stage 1: it lives in the VM's `~/.claude`, survives suspend/resume, and
is preserved across VM replacement by the Checkpoint. Stage 2 (named
follow-on): its source of truth moves to the Postgres SessionStore.
_Avoid_: chat history, workspace

**Workspace**:
The Conversation's working directory on its VM's disk — where the confined
file tools act (cwd-scoped). It survives suspend/resume natively and VM
replacement via the Checkpoint. Not the Agent session, and not
durable beyond the Checkpoint.
_Avoid_: sandbox, E2B (retired)

**Checkpoint**:
The Conversation's durable state bundle — the Agent session (`~/.claude`) and
the Workspace — handed by the In-VM server to chat-api's `/v2/checkpoint`
door on the suspend hook (the VM has no path to S3; chat-api writes the
Conversation's S3 prefix and moves the pointer), and restored on boot before
the VM serves.
The suspend-time Checkpoint is the durable one and is always complete:
terminating a suspended VM fires no hook. Rehydration (a fresh VM restoring
the Checkpoint) is how Conversations survive the platform's 8-hour cap and how
image upgrades land.
_Avoid_: snapshot (the platform's suspend artifact), backup

**Gateway**:
The streaming passthrough route in chat-api that is the VM's single door to
the internet. It validates the per-Conversation token (delivered to the VM via
`runHookPayload`, used by the SDK as its API-key placeholder), injects the
real provider credential, forwards unbuffered, and logs per-Conversation
usage. The provider key never enters the VM; VM egress is network-locked to
RDS, Redis, and this route.
_Avoid_: proxy service (it is a route, not a deployable), firewall

**v2 chat surface**:
The client data plane: `POST /v2/conversations/:id/messages` submits a
UIMessage and streams the Turn's UIMessage events; `GET` reads history;
`POST …/interrupt` stops the processing Turn. The resource is the
Conversation; there is no client-visible Turn admission and no 409 — queueing
falls out of the schema.
_Avoid_: AI SDK agent surface (the v1-era name), AG-UI (retired with v1)

**Searchable document**:
An immutable item in the MyMemo knowledge base whose identity is stable across
indexed versions. Searchable documents can be deactivated; a conversation's
document inventory counts each active one once within its frozen scope.
_Avoid_: document (ambiguous), workspace document, file

**Indexed document version**:
One immutable indexed representation of a searchable document. Reindexing can
create a new version without creating another document-inventory item. The
highest active version is the searchable document's current version.
_Avoid_: searchable document (that is the stable item across versions)

**Workspace document**:
An editable document created inside a conversation's workspace. It is user
work and never belongs to the searchable document inventory.
_Avoid_: searchable document, knowledge-base document

**Document inventory**:
The distinct active searchable documents visible within a conversation's
frozen scope. Inventory counts and browsing never widen beyond that scope.
_Avoid_: library (that can imply every document owned by the user)

**Passage**:
An indexed chunk of a searchable document — the search and citation unit. A
passage points at its searchable document.
_Avoid_: chunk, excerpt

**Docs cache**:
The reserved directory in a Conversation's Workspace where loaded
searchable-document content is materialized by the document tools.
Reconstructible from the KB, carried by the Checkpoint, never user work, dies
with the Conversation.
_Avoid_: document store, workspace docs

**Load**:
Materializing a searchable document's full content into the docs cache,
disk-only, with a metadata-only result. Re-loading a searchable document
refreshes its cached copy.
_Avoid_: fetch (the prototype path's word for content-into-context)

## v1 language (historical — describes the Run path still serving production; retires with it at teardown)

One-line gists; full definitions live in git history at this file's pre-v2
revisions. Never use these terms for v2 work.

- **Run / Active Run / Run interruption / Run event**: the v1 execution model —
  admitted, ordered backend attempts with a durable Postgres event log.
  Replaced by Turns on the user-message row.
- **AG-UI agent surface**: the v1 client data plane (RunAgentInput / AG-UI
  events). Replaced by the v2 chat surface.
- **AgentCore dispatch / Dispatch publication / Dispatch publisher / Dispatch
  disposition / Acquisition receipt / Durable acquisition / Runtime session**:
  the v1 dispatch pipeline delivering Runs to AgentCore. Retired; v2 has no
  dispatch — the VM pulls from Postgres.
- **Conversation Ownership / Ownership lease / Ownership epoch / Reclamation**:
  v1's exclusive-execution fencing and crash recovery. Replaced by the
  one-VM-per-Conversation tenancy, the transactional launch claim, and the
  boot-time Turn sweep.
- **Reconnecting**: v1's mid-Run Live-Stream re-attach with backlog. Deleted in
  v2 — Recovering is the only post-disconnect story.
- **Session mirror evidence**: v1's SessionStore mirroring proof. Returns, in
  new form, with stage 2.
- **Harness sandbox / Harness turn**: the abandoned Vercel/Harness chat path
  (never production-mounted).
- **Downloadable artifact**: v1's published workspace files and routes. Not
  carried to v2.0; workspace files persist in the Checkpoint; publication may
  return as an additive follow-on.
- **Split runtime**: ADR-0001's trusted-loop/untrusted-execution split across
  services. Repealed a second way by ADR-0034's in-VM process boundary.
- **Prototype path**: the pre-split daemon architecture. Decommissioned long
  before v2; never a fallback.
