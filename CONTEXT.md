# MyMemo Agent

The MyMemo agent runtime: a chat service where a trusted agent loop works
over a user's knowledge-base documents and workspace files, with untrusted
code execution isolated in a per-conversation sandbox.

## Language

**Conversation**:
The durable, user-visible container for a chat. Its document scope is frozen
at creation and never changes for its lifetime.
_Avoid_: chat, session, thread

**Scope**:
The set of documents a conversation may access — `general`, `collection`, or
`document`. Resolved once at conversation creation, then only ever re-read.
_Avoid_: permissions, access level

**Run**:
One backend execution attempt serving a user message. At most one run per
conversation is active at a time, and in v1 a run executes at most once —
never requeued or automatically retried.
_Avoid_: job, task, attempt

**Claim**:
Taking exclusive execution ownership of a queued run. A v1 run is claimed at
most once; a stale run is terminalized, never reclaimed.
_Avoid_: lease (that word belongs to the decommissioned prototype path)

**Run event**:
One record in a run's durable, ordered event log — the source of truth for
what happened during a run and the only source for authoritative, replayable
client frames. Cursorless Live preview is ephemeral evidence, never a Run
event, and may be lost without changing the Run outcome or transcript.

**Live preview**:
Provisional assistant text shown while its durable assistant message is still
being produced. It may be incomplete or missed; it is committed by the durable
message, or discarded if the run ends before that message completes.
_Avoid_: transcript, run event, token stream

**Assistant message**:
One complete model-authored provider response within a run, regardless of how
many content blocks carry it. Its durable text commits any live preview of that
response and is the form used for replay.
_Avoid_: text delta, token stream

**Tool invocation**:
One agent request to execute a model-facing tool, recorded as a durable run
event and identified in the user-visible history by the tool name and a
bounded, client-safe projection of its arguments. Its result is recorded as a
separate chronological item rather than updating the invocation.
_Avoid_: tool call

**Tool result**:
The bounded, client-safe projection of returned content or an error indication
from a tool invocation, recorded as an append-only durable run event in the
user-visible history. It carries no client-facing correlation identifier, and
content is exposed only as a capped, non-authoritative preview, even when a
short source happens to fit completely. An invocation has no result when the
run terminates before the tool returns. An error result does not end the run;
the agent may continue after inspecting it.
_Avoid_: tool response

**Outcome**:
The single way a run ends: `done`, `error`, or `canceled`. One word per
outcome at every layer — status `done`, run event `run_done`, client frame
`done`; likewise `error`/`run_error` and `canceled`/`run_canceled`.
_Avoid_: completed, failed, finished, succeeded

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

**Workspace**:
The conversation's sandbox filesystem (E2B `/home/user`) where the model's
file and shell tools act. It *is* the paused E2B sandbox between turns —
persistence is best-effort: reconnect restores it, but a lost sandbox starts
the next turn empty. Not the Fargate query cwd (that is only a stable
projectKey anchor), and not durable like the agent session.
_Avoid_: sandbox (that is the runtime; the workspace is its filesystem)

**Downloadable artifact**:
A file deliberately published from a conversation's workspace for durable,
user-visible listing and download, identified by its conversation-relative
artifact path. Publishing that path again replaces the artifact; ordinary
workspace files and the docs cache are not downloadable artifacts merely
because they exist.
_Avoid_: created file, attachment

**Docs cache**:
The reserved directory in a conversation's sandbox workspace where loaded
searchable-document content is materialized. Reconstructible from the KB,
persists across turns, never user work, dies with the conversation.
_Avoid_: document store, workspace docs

**Load**:
Materializing a searchable document's full content into the docs cache,
disk-only, with a metadata-only result. Re-loading a searchable document
refreshes its cached copy.
_Avoid_: fetch (the prototype path's word for content-into-context)

**Agent session**:
The Claude SDK transcript that carries a conversation's model-side memory
across turns. Internal and worker-owned — never client-facing, never in the
sandbox.
_Avoid_: chat history (that is the user-visible record in run events)

**Split runtime**:
The target architecture: the agent loop runs in trusted Fargate workers
while untrusted filesystem and shell execution stays in E2B.

**Prototype path**:
The superseded daemon-based architecture — agent loop inside the sandbox,
gateway, per-turn tokens, sandbox leases. Decommissioned by hard swap; never
a fallback.
