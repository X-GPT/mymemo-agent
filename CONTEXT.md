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
what happened during a run and the only source for anything streamed to the
client.

**Outcome**:
The single way a run ends: `done`, `error`, or `canceled`. One word per
outcome at every layer — status `done`, run event `run_done`, client frame
`done`; likewise `error`/`run_error` and `canceled`/`run_canceled`.
_Avoid_: completed, failed, finished, succeeded

**Document**:
An item in the MyMemo knowledge base: an ingested summary (immutable once
created) or a user-created document (editable). Documents can be
deactivated; queries only ever see active ones.
_Avoid_: file (that word means workspace files in the sandbox)

**Passage**:
An indexed chunk of a document — the search and citation unit. A passage
points at its document.
_Avoid_: chunk, excerpt

**Workspace**:
The conversation's sandbox filesystem (E2B `/home/user`) where the model's
file and shell tools act. It *is* the paused E2B sandbox between turns —
persistence is best-effort: reconnect restores it, but a lost sandbox starts
the next turn empty. Not the Fargate query cwd (that is only a stable
projectKey anchor), and not durable like the agent session.
_Avoid_: sandbox (that is the runtime; the workspace is its filesystem)

**Docs cache**:
The reserved directory in a conversation's sandbox workspace where loaded
document content is materialized. Reconstructible from the KB, persists
across turns, never user work, dies with the conversation.
_Avoid_: document store, workspace docs

**Load**:
Materializing a document's full content into the docs cache, disk-only, with
a metadata-only result. Re-loading a document refreshes its cached copy.
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
