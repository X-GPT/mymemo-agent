# MyMemo Agent

The MyMemo agent runtime: a chat service where a Lambda front admits each
Turn and records it, the AgentCore Runtime runs the Claude Agent SDK loop, and
every model-driven tool executes in a fresh Code Interpreter sandbox holding a
copy of the Conversation's Workspace. Decided on ADR-0035; built to
Spec #732.

## Language

**Conversation**:
The durable, user-visible container for a chat. Its document scope is frozen
at creation and never changes for its lifetime. It owns one DynamoDB item,
one Workspace tarball, one Agent session, and one history prefix in S3.
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
route answers 404; the Cleanup sweep then removes the Workspace, the artifact
copies, the history objects, the Agent session and the items, retrying until
clean.
_Avoid_: Archive, soft delete

**Tombstone**:
The `deletedAt` mark on the Conversation item. It hides the Conversation
instantly, blocks `send`, and stays until the Cleanup sweep has deleted
everything else — it is never expired automatically.
_Avoid_: deleted flag, TTL

**Cleanup sweep**:
The five-minute scheduled run of the Lambda front that drains Tombstoned
Conversations: the `_workspace`, `_artifacts`, `_history` and transcript
prefixes, then the DynamoDB items, Tombstone last. Idempotent; a failure
leaves the Tombstone for the next run. Alarmed on backlog age.
_Avoid_: reaper, maintenance (the v1 reclaimer), garbage collection

**Scope**:
The set of documents a Conversation may access — `general`, `collection`, or
`document`. Resolved once at Conversation creation, then only ever re-read.
_Avoid_: permissions, access level

**Lambda front**:
The one Lambda (Hono, behind an IAM-authenticated streaming Function URL)
that mymemo-service calls. It verifies identity and the exposure gate,
resolves Scope, owns the DynamoDB Conversation record, admits Turns by single
flight, starts the Turn's Sandbox session and copies the Workspace in, invokes
the Runtime, converts the Runtime's raw SDK messages into the UIMessage
stream for the client, and when the stream ends copies the Workspace and the
Artifacts out, stops the session, and writes the Turn's reply once, whole, to
S3. It is the only writer of everything durable except the transcript.
_Avoid_: chat-api (the v1 ECS service), gateway, BFF (that is mymemo-service)

**Exposure gate**:
The Statsig server gate `mymemo_agent_split_runtime_enabled`, evaluated by
the Lambda front on Conversation creation and on `send` with the member,
partner and team identity. Fails closed: a gate error or an unreachable
Statsig is a 403.
_Avoid_: feature flag, rollout percentage

**Runtime**:
The AgentCore Runtime hosting `apps/agentcore-runtime`: the trusted process
that holds the model and knowledge-base credentials, runs the Claude Agent
SDK `query()`, and serves the Hand and the document tools as in-process MCP
servers against the Sandbox session whose id the Lambda front passed in. It
streams the SDK's own messages back verbatim. It never touches DynamoDB or
the Workspace; the only S3 it writes is the transcript. One Runtime session
per Turn (session id = Turn id).
_Avoid_: execution runtime (the v1/v2 term), worker, In-VM server, agent loop

**Hand**:
The in-process MCP server in the Runtime that fronts the Code Interpreter
sandbox as the model's six file and shell tools (`Bash`, `Read`, `Write`,
`Edit`, `Glob`, `Grep`, aliased to `mcp__hand__*`). It caps outputs at
64 KiB, confines every path to the Workspace directory `ws/` in the sandbox,
and maps the model's `/ws/<path>` to the sandbox's relative form. The model
has no other tool that touches files.
_Avoid_: sandbox tools, built-in tools, remote tools

**Sandbox session**:
One Code Interpreter session in `SANDBOX` network mode — a fresh microVM
with no credential, no VPC and no reachable endpoint but the region's
anonymous S3 — started by the Lambda front before the Turn with the
Workspace copied in, used by the Runtime's Hand during the Turn, and stopped
by the front after the Workspace is copied out. It is never resumed; a
session lost mid-Turn ends the Turn as an error.
_Avoid_: sandbox (ambiguous), E2B, MicroVM (the deleted v2 design), mount

**Workspace**:
The Conversation's durable files: one tarball at `_workspace/<id>/` on the
workspace bucket, at most 64 MB compressed, copied by the Lambda front into
every Sandbox session at `~/ws` before the Turn and copied out after it.
`artifacts/` is the artifact folder; `.mymemo/docs/` is the Docs cache. It
dies with the Conversation. Large data belongs in the knowledge base, not
here.
_Avoid_: sandbox disk, mount, checkpoint, scratch

**Turn**:
The processing of one user message: admitted by the Lambda front's single
flight, executed by the Runtime at most once, recorded by the Lambda front as
one S3 object holding the user message and, once the stream ends, the whole
reply and its Outcome. A Turn's reply is whole or absent — nothing partial is
ever stored. A second `send` while a Turn is processing is refused with 409;
the client resends after the stream ends.
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
`budget_exceeded`, `abandoned`, `quota_exceeded`, `workspace_too_large`,
`internal_error`) or `abandoned` (a Turn whose reply was never recorded,
marked when a later `send` finds it stale). One word per Outcome at every
layer.
_Avoid_: completed, failed, finished, interrupted

**Step**:
One model call within a Turn, delimited on the stream by
`start-step`/`finish-step`. A unit of the stream only: Steps are folded into
the Assistant message in the Lambda front's memory and stored together when
the Turn ends, never one by one.
_Avoid_: turn (a Turn spans Steps), message, item

**Assistant message**:
The Turn's single model-authored UIMessage: its id minted by the Lambda front,
its parts converted from the Runtime's SDK messages, written once with the
Turn's object when the stream ends. Streamed once, re-served from history
identically.
_Avoid_: provider response (that is a Step), token stream

**Conversation history**:
The durable, user-visible record: one S3 object per Turn under
`_history/<id>/`, read newest first with cursor paging and served as user
and assistant UIMessages. A Turn still processing shows its user message and
`status: processing` with no reply; the client renders "working". There is no
stream resume; history is the only post-disconnect story.
_Avoid_: transcript (that is the Agent session), thread history, Run history, Step item

**Catalog payload**:
A display-only generative-UI node from the ADR-0017 catalog, validated by
the `PresentUI` tool in the Runtime, carried as a `data-generative-ui` part
with a stable MyMemo-issued id, and stored with the reply when the Turn ends.
_Avoid_: HTML widget (the cut lane), component (ambiguous)

**Artifact**:
A file under the Workspace's `artifacts/` folder, copied by the Lambda front
at Turn end to `_artifacts/<id>/<path>` as its own S3 object and listed in a
manifest with a path-derived stable id; the list mirrors the folder (a
removed file disappears). Downloaded through a five-minute presigned URL that
works as soon as the Turn ends.
_Avoid_: published artifact, attachment, output file, mount listing

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
through the Hand. Reconstructible from the KB, never user work, travels with
the Workspace tarball, dies with the Conversation.
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
- **S3 Files mount / Access point per Conversation / Step item / Artifact
  row / `not_exported_yet`**: the first cut of this design (2026-09-05),
  replaced on 2026-09-06 by the tarball Workspace, whole-reply history in S3
  and artifact copies at Turn end (ADR-0035 amendment).
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
