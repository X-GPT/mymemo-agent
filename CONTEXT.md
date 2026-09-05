# MyMemo Agent

The MyMemo agent runtime: a chat service where a Lambda front admits each
Turn, the AgentCore Runtime runs the Claude Agent SDK loop, and every
model-driven tool executes in a Code Interpreter sandbox mounted on the
Conversation's own S3-backed Workspace. Decided on ADR-0035; built to
Spec #732.

## Language

**Conversation**:
The durable, user-visible container for a chat. Its document scope is frozen
at creation and never changes for its lifetime. It owns one Workspace (an S3
Files access point), one Agent session and one DynamoDB partition.
_Avoid_: chat, session, thread

**Conversation title**:
The persisted, user-visible label of a Conversation. It is initialized from
the first user message when still unset, then changes only through an
explicit rename.
_Avoid_: summary, generated response

**Conversation activity**:
The most recent user message whose `send` won, or Conversation creation when
none has. It determines list recency; rename and Archive are not Conversation
activity.
_Avoid_: metadata update, Turn completion

**Archive**:
A reversible lifecycle change that removes a Conversation from the default
Conversation list and refuses new `send`s (409 `archived`), without deleting
the Conversation, its history or its Workspace. A processing Turn completes.
Nothing expires: an archived Conversation lives until permanently deleted.
_Avoid_: delete, close, expire

**Permanent deletion**:
The irreversible end of a Conversation. `DELETE` writes a Tombstone in one
conditioned write (refused while a Turn is processing), after which every
route answers 404; the Cleanup sweep then removes the Workspace (all object
versions), the Agent session, the access point and the items, retrying until
clean.
_Avoid_: Archive, soft delete

**Tombstone**:
The `deletedAt` mark on the Conversation item. It hides the Conversation
instantly, blocks `send`, and stays until the Cleanup sweep has deleted
everything else — it is never expired automatically.
_Avoid_: deleted flag, TTL

**Cleanup sweep**:
The five-minute scheduled run of the Lambda front that drains Tombstoned
Conversations: Workspace versions and delete markers, transcript prefix,
access point, DynamoDB items, Tombstone last. Idempotent; a failure leaves the
Tombstone for the next run. Alarmed on backlog age.
_Avoid_: reaper, maintenance (the v1 reclaimer), garbage collection

**Scope**:
The set of documents a Conversation may access — `general`, `collection`, or
`document`. Resolved once at Conversation creation, then only ever re-read.
_Avoid_: permissions, access level

**Lambda front**:
The one Lambda (Hono, behind an IAM-authenticated streaming Function URL)
that mymemo-service calls. It verifies identity and the exposure gate,
resolves Scope, owns the DynamoDB Conversation record, admits Turns by single
flight, invokes the Runtime with streaming and relays the UIMessage stream
byte for byte. It never ends a Turn.
_Avoid_: chat-api (the v1 ECS service), gateway, BFF (that is mymemo-service)

**Exposure gate**:
The Statsig server gate `mymemo_agent_split_runtime_enabled`, evaluated by
the Lambda front on Conversation creation and on `send` with the member,
partner and team identity. Fails closed: a gate error or an unreachable
Statsig is a 403.
_Avoid_: feature flag, rollout percentage

**Runtime**:
The AgentCore Runtime hosting `apps/agentcore-runtime`: the trusted process
that holds every credential, runs the Claude Agent SDK `query()`, serves the
Hand and the document tools as in-process MCP servers, writes Steps and the
Turn's Outcome to DynamoDB, and streams UIMessage chunks back to the Lambda
front. One Runtime session per Turn (session id = Turn id).
_Avoid_: execution runtime (the v1/v2 term), worker, In-VM server, agent loop

**Hand**:
The in-process MCP server in the Runtime that fronts the Code Interpreter
sandbox as the model's six file and shell tools (`Bash`, `Read`, `Write`,
`Edit`, `Glob`, `Grep`, aliased to `mcp__hand__*`). It caps outputs at
64 KiB, confines every path to the Workspace mount, and translates paths into
the sandbox's relative form. The model has no other tool that touches files.
_Avoid_: sandbox tools, built-in tools, remote tools

**Sandbox session**:
One Code Interpreter session — a microVM with the Conversation's Workspace
mounted at `/mnt/ws`, no credential and no network route — started by the
Runtime at Turn start and stopped at Turn end. It is never resumed; a session
lost mid-Turn surfaces as a tool error and the Hand starts a fresh one.
_Avoid_: sandbox (ambiguous), E2B, MicroVM (the deleted v2 design)

**Workspace**:
The Conversation's durable files: an S3 Files access point rooted at the
Conversation's prefix on the workspace bucket, mounted into every Sandbox
session at `/mnt/ws`. Writes become object versions about a minute after
write inactivity; the bucket is authoritative. `artifacts/` is the artifact
store; `.mymemo/docs/` is the Docs cache. It dies with the Conversation.
_Avoid_: sandbox disk, checkpoint, scratch

**Turn**:
The processing of one user message: admitted by the Lambda front's single
flight, executed by the Runtime at most once, ended only by the Runtime with
an Outcome. The user message and the Turn record are one DynamoDB item; the
assistant reply is its Step items. A second `send` while a Turn is processing
is refused with 409; the client resends after the stream ends.
_Avoid_: Run (the v1 term), request, job, queue entry (there is no queue)

**Single flight**:
The rule that a Conversation processes one Turn at a time, enforced by one
conditional write on `processing { turnId, until }`. There is no queue and no
reclaimer: a `processing` past its `until` is stale, and the next `send`
marks that Turn `abandoned` in the same write that admits the new one.
_Avoid_: lock, lease, fencing token, ownership

**Turn budget**:
Ten minutes of wall clock per Turn, enforced by the Runtime aborting the SDK
query (`budget_exceeded`), with two minutes of grace before `until`. It is the
only way a Turn ends early; there is no interrupt.
_Avoid_: timeout (the Lambda's 14 minutes is the transport ceiling, not the
budget), cancellation

**Request id**:
The client-generated id sent with each `send` and kept across retries.
`(conversationId, requestId)` identifies a Turn: the same id with the same
text is a duplicate (409, reload history), with different text a conflict.
_Avoid_: message id (the front mints those), idempotency token

**Outcome**:
The single way a Turn ends: `done`, `error` (with an error code —
`budget_exceeded`, `abandoned`, `quota_exceeded`, `internal_error`) or
`abandoned` (marked by a later `send` after the budget passed). One word per
Outcome at every layer.
_Avoid_: completed, failed, finished, interrupted

**Step**:
One model call within a Turn, delimited on the stream by
`start-step`/`finish-step` and stored as one DynamoDB item holding that Step's
parts, written whole at `finish-step` and rewritten on every data part. The
durability unit: a Turn that ends in error keeps exactly its completed Steps.
_Avoid_: turn (a Turn spans Steps), message

**Assistant message**:
The Turn's single model-authored UIMessage: its id minted by the Lambda front,
its parts the ordered Step items, its metadata the Turn record. Streamed once,
re-served from history identically.
_Avoid_: provider response (that is a Step), token stream

**Conversation history**:
The durable, user-visible record: the Turn and Step items of the
Conversation's partition, read newest Turn first with cursor paging and
assembled into user and assistant UIMessages. Written incrementally by the
Runtime, so a reload mid-Turn shows the finished Steps and
`status: processing`. There is no stream resume; history is the only
post-disconnect story.
_Avoid_: transcript (that is the Agent session), thread history, Run history

**Catalog payload**:
A display-only generative-UI node from the ADR-0017 catalog, carried as a
`data-generative-ui` part with a stable MyMemo-issued id, validated and
persisted into its Step before it is streamed.
_Avoid_: HTML widget (the cut lane), component (ambiguous)

**Artifact**:
A file under the Workspace's `artifacts/` subtree, listed by the Runtime at
Turn end into DynamoDB with a path-derived stable id; the list mirrors the
folder (a removed file disappears). Downloaded through a five-minute presigned
URL that answers 409 until S3 Files has exported the object.
_Avoid_: published artifact, attachment, output file

**Agent session**:
The Claude SDK transcript carrying a Conversation's model-side memory across
Turns, mirrored by the SDK to the transcript prefix on the workspace bucket
(outside every access point) and loaded from there at each Turn. Its session
id is the Conversation id. A dropped mirror batch is an accepted loss of
memory, never of history.
_Avoid_: chat history, workspace, checkpoint

**Chat surface**:
The client data plane on the Lambda front: v1's eight `/v1/conversations`
routes carried over, with `POST …/messages` streaming the AI SDK UIMessage
stream for the submitted Turn and `GET …/messages` serving history.
_Avoid_: AG-UI agent surface (retired), v2 chat surface (deleted)

**Searchable document**:
An immutable item in the MyMemo knowledge base whose identity is stable across
indexed versions. Searchable documents can be deactivated; a Conversation's
document inventory counts each active one once within its frozen scope.
_Avoid_: document (ambiguous), workspace document, file

**Indexed document version**:
One immutable indexed representation of a searchable document. Reindexing can
create a new version without creating another document-inventory item. The
highest active version is the searchable document's current version.
_Avoid_: searchable document (that is the stable item across versions)

**Workspace document**:
An editable document created inside a Conversation's Workspace. It is user
work and never belongs to the searchable document inventory.
_Avoid_: searchable document, knowledge-base document

**Document inventory**:
The distinct active searchable documents visible within a Conversation's
frozen scope. Inventory counts and browsing never widen beyond that scope.
_Avoid_: library (that can imply every document owned by the user)

**Passage**:
An indexed chunk of a searchable document — the search and citation unit. A
passage points at its searchable document.
_Avoid_: chunk, excerpt

**Docs cache**:
The reserved `.mymemo/docs/` directory in a Conversation's Workspace where
loaded searchable-document content is materialized by the document tools
through the Hand. Reconstructible from the KB, never user work, dies with the
Conversation.
_Avoid_: document store, workspace docs

**Load**:
Materializing a searchable document's full content into the Docs cache,
disk-only, with a metadata-only result. Re-loading a searchable document
refreshes its cached copy.
_Avoid_: fetch (the prototype path's word for content-into-context)

## Retired language (historical — never use for new work)

One-line gists; full definitions live in git history.

- **Run / Active Run / Run interruption / Run event / AG-UI agent surface /
  AgentCore dispatch / Dispatch publisher / Acquisition receipt / Conversation
  Ownership / Ownership epoch / Reclamation / Reconnecting / Session mirror
  evidence**: the v1 execution model still serving production until cutover
  — admitted Runs on a Postgres event log, delivered through an outbox to
  AgentCore + E2B, fenced by ownership epochs, streamed over Redis. Replaced
  by Turns, single flight, the Hand and DynamoDB.
- **Execution runtime / In-VM server / Nudge / Interruption / Live Stream /
  Assistant text delta / Recovering / Checkpoint / Gateway / v2 chat
  surface**: the `/v2` Lambda MicroVM design (ADR-0034), deleted on
  2026-09-04 before serving production. Its Postgres-as-work-bus queue,
  interrupt command and checkpoint bundle have no successor.
- **Harness sandbox / Harness turn**: the abandoned Vercel/Harness chat path
  (never production-mounted).
- **Downloadable artifact (published)**: v1's publish-on-success copy of
  workspace files. Replaced by the mirrored `artifacts/` folder.
- **Sandboxed-HTML lane / Sandbox origin**: the model-authored HTML widget
  lane on a separate Cloudflare origin. Cut; the Worker and its source are
  deleted.
- **Split runtime**: ADR-0001's trusted-loop/untrusted-execution split across
  services. Its stance survives as "the Runtime holds every credential, the
  sandbox holds none".
- **Prototype path**: the pre-split daemon architecture. Decommissioned long
  before v1; never a fallback.
