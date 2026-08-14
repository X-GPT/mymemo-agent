# MyMemo Agent

The MyMemo agent runtime: a chat service where a trusted agent loop works
over a user's knowledge-base documents and workspace files, with untrusted
code execution isolated in a per-conversation sandbox.

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
_Avoid_: metadata update, Run completion

**Archive**:
A reversible lifecycle change that removes a Conversation from the default
Conversation list and prevents it from receiving new messages, without deleting
the Conversation or its history.
_Avoid_: delete, close

**Permanent deletion**:
The irreversible end of a Conversation that removes it and makes its history
and Downloadable artifacts inaccessible. A Conversation with an active Run
cannot be permanently deleted.
_Avoid_: Archive, soft delete

**Scope**:
The set of documents a conversation may access — `general`, `collection`, or
`document`. Resolved once at conversation creation, then only ever re-read.
_Avoid_: permissions, access level

**Execution lane**:
The immutable classification of a Conversation that determines which runtime
may claim and execute its Runs. A Conversation never mixes runtimes.
_Avoid_: Run target, worker preference, routing hint

**AgentCore canary**:
An operator-triggered, traffic-free production exercise that runs only
synthetic Conversations on the AgentCore execution lane while Fargate remains
the user-traffic runtime.
_Avoid_: rollout, shadow traffic, production migration

**Canary campaign**:
One bounded, on-demand AgentCore canary exercise over a fresh synthetic
Conversation, ending in a recorded Canary verdict and explicit cleanup.
_Avoid_: scheduled probe, continuous canary, rollout stage

**Canary scenario**:
One versioned behavior probe within a Canary campaign, represented by one exact
Run whose identity is stable across control-plane retries.
_Avoid_: Run retry, test attempt, workflow step

**Canary verdict**:
The outcome of a Canary campaign: `pass_for_rollout_review`, `fail`, or
`inconclusive`. An observed requirement violation is a failure; inconclusive
means the required behavior could not be observed. A verdict informs a separate
rollout decision and never changes user routing itself.
_Avoid_: rollout approval, deployment status, Run Outcome

**Canary fixture**:
The versioned synthetic identity, collection, documents, and expected outputs
used by every Canary campaign. It contains no real-user data.
_Avoid_: test user, production sample, general Scope

**AgentCore dispatch**:
An at-least-once request for AgentCore to acquire one exact Run from an
AgentCore-canary Conversation. Repeated delivery never creates another Run.
_Avoid_: Run retry, job, invocation attempt

**Durable acquisition**:
The committed transition in which one AgentCore invocation obtains live
Conversation Ownership and starts its exact dispatched Run. Runtime entry or
an HTTP response alone is not acquisition.
_Avoid_: container start, invocation acceptance, queue acknowledgement

**Dispatch disposition**:
The typed result of evaluating an AgentCore dispatch against durable Run and
Ownership state, determining whether delivery is acknowledged or retried.
_Avoid_: duplicate-or-missing, HTTP status, Run Outcome

**Acquisition receipt**:
The versioned, machine-readable proof that an AgentCore dispatch reached one
specific Dispatch disposition. It is emitted only after the disposition's
durable facts commit and contains no user or secret content.
_Avoid_: AG-UI event, HTTP success, log line

**Runtime session**:
The AgentCore compute-lifecycle identity used to reconnect or stop the compute
serving a synthetic Conversation. It is not the Claude Agent session and does
not own Run ordering or continuity.
_Avoid_: Agent session, Conversation, worker id

**Campaign record**:
The durable control record for one Canary campaign, including its identity,
version, synthetic Conversation, lifecycle status, Canary verdict, and evidence
location.
_Avoid_: Step Functions execution, workflow run, Run

**Canary report**:
The signed, bounded evidence artifact derived from a Canary campaign, recording
every gate, observation, cleanup result, cost estimate, and Canary verdict
without user content or secret values.
_Avoid_: log bundle, rollout approval, Conversation history

**Run**:
One backend execution attempt serving a user message. A Conversation's Runs are
executed one at a time in submission order, and a Run executes at most once —
never requeued or automatically retried.
_Avoid_: job, task, attempt

**Active Run**:
A Run that has been admitted but has not yet reached its Outcome. A Conversation
may hold only a bounded number of them at once; a submission past that bound is
refused rather than accepted and delayed.
_Avoid_: pending run, in-flight run, queued run (that is one status among several)

**Run interruption**:
A user-requested end to one queued or running Run that leaves its Conversation,
Agent session, and Workspace available for later Runs, and its Conversation's
other active Runs unaffected. Once accepted before another Outcome, interruption
wins the Run's Outcome and prevents Downloadable artifact publication.
_Avoid_: cancellation, Conversation termination, HITL interrupt

**Claim**:
Taking exclusive execution ownership of a Conversation in order to serve, one at
a time in submission order, the Runs it had active at that moment. A Conversation
is claimed many times over its life by any worker, and Runs submitted after a
Claim are left for a later one.
_Avoid_: job reservation, run claim

**Ownership lease**:
The time-bounded, exclusive write authority over one Conversation and every
resource scoped to it, obtained by claiming it and kept alive by heartbeat. Once
it lapses or is superseded, that holder's writes are rejected.
_Avoid_: run lease, sandbox lease (the decommissioned prototype concept)

**Ownership epoch**:
The per-Conversation number identifying one Claim, increasing with every Claim.
It names the holder in every fenced write, so a superseded holder is rejected
even while it still believes it holds the lease.
_Avoid_: fencing token, version, generation

**Reclamation**:
Terminalizing the started Runs of a Conversation whose Ownership lease lapsed
without release, so a Conversation whose worker vanished cannot hold executing
Runs that never reach an Outcome. Never-started queued Runs remain for the next
Claim. Distinct from Recovering, which is a client behavior.
_Avoid_: recovery (that word is the client-side term), stale-run recovery

**Run event**:
One record in a Run's durable, ordered Postgres event log — the source of truth
for its completed Assistant messages, Tool activity, Outcome, and permanent
Conversation history. A Run event may also be published to the Run's Live
Stream after it commits, but Assistant text deltas are Live Stream entries and
not Run events.

**Live Stream**:
The temporary, ordered sequence of standard AG-UI events for one active Run,
buffered in the producing worker's memory and relayed event-by-event over Redis
pub/sub. No stream content is stored in Redis: a reader attaches by requesting
the full backlog from the living producer, and every reconnect rebuilds the
active Run from that backlog. The Live Stream ends with the Run's Outcome and
dies with its producer; after either, permanent Conversation history is the
only source.
_Avoid_: Live preview, retained stream, replay cursor, Conversation history

**Reconnecting**:
Re-attaching to a usable Live Stream after a transient transport interruption,
rebuilding the active Run from its full backlog.
_Avoid_: Recovering, resuming after a cursor

**Recovering**:
Waiting for permanent Conversation history after a Live Stream becomes
unusable, then replacing the Run's provisional client state with that durable
projection.
_Avoid_: Reconnecting, Reclamation (that is the worker-side term)

**Conversation history**:
The durable, user-visible record of submitted messages, Assistant messages,
Tool activity, and Outcomes across a Conversation. It lasts as long as the
Conversation and excludes provisional Live Stream text and the internal Agent session. On the
public agent surface it is represented as AG-UI messages grouped by Run, with
the Run's AG-UI terminal event kept alongside those messages rather than
inventing an Outcome message. An interrupted Run retains every Run event
committed before interruption; its provisional open response is excluded. A
queued interruption retains the submitted User message even when no worker
delivered it to Claude.
_Avoid_: thread history, Agent session, transcript

**AG-UI agent surface**:
The interoperable data plane through which a client starts a Run with
`RunAgentInput` and receives standard AG-UI events. Its `threadId` names a
MyMemo Conversation, its client-generated `runId` becomes the canonical Run
identity and idempotency key on admission, and its `messageId` and `toolCallId`
map to MyMemo-issued stable identities. Conversation listing, lifecycle, Scope,
authorization, history paging, and artifacts remain MyMemo resource concerns.
_Avoid_: Conversation API, Assistant Cloud

**Assistant text delta**:
A bounded, provisional fragment of Assistant text appended to the Run's Live
Stream before the provider response completes. It is never copied into Postgres
as a delta row and may disappear when the Live Stream ends.
_Avoid_: Run event, durable message, token

**Assistant message**:
One model-authored provider response within a run, identified by a stable,
opaque, MyMemo-issued message id regardless of how many content blocks carry
it. Assistant text remains provisional in the Live Stream until the provider
response completes; the complete message is then committed to Postgres before
its completion event is appended to the Live Stream. A textless response
exposes its identity through its Tool invocations or its durable generative UI
payloads. If its Run is interrupted or fails before completion, its provisional
text does not enter permanent Conversation history.
_Avoid_: token stream

**Tool invocation**:
One agent request to execute a model-facing tool, recorded as a durable run
event and identified in the user-visible history by a stable, opaque,
MyMemo-issued Tool invocation id, the tool name, and a bounded, client-safe
projection of its arguments. It also carries the id of its owning Assistant
message. Its result is recorded as a separate chronological item rather than
updating the invocation.
_Avoid_: tool call

**Tool result**:
The bounded, client-safe projection of returned content or an error indication
from a tool invocation, recorded as an append-only durable run event in the
user-visible history and linked to its Tool invocation by the same stable,
opaque, MyMemo-issued id. Content is exposed only as a capped,
non-authoritative preview, even when a short source happens to fit completely.
An invocation has no result when the run terminates before the tool returns. An
interruption does not fabricate a failure result for such an invocation. An
error result does not end the run; the agent may continue after inspecting it.
_Avoid_: tool response

**Outcome**:
The single way a Run ends: `done`, `error`, or `interrupted`. One word per
outcome at every layer — status `done`, run event `run_done`, client frame
`done`; likewise `error`/`run_error` and
`interrupted`/`run_interrupted`/`RUN_INTERRUPTED`.
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
the next turn empty. Run interruption preserves its current contents rather
than rolling them back, so stopping a command may leave partial edits for a
later Run to inspect or repair. Not the Fargate query cwd (that is only a stable
projectKey anchor), and not durable like the Agent session.
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
The internal, worker-owned Claude SDK transcript that carries a Conversation's
model-side memory across Runs, including a successfully preserved interrupted
Run even when its provisional response is absent from Conversation history. It
is never client-facing or stored in the Workspace.
_Avoid_: chat history (that is the user-visible record in run events)

**Session mirror evidence**:
A Run-local fact established only when its bound SessionStore successfully
persists a non-empty batch for the main Agent session and has not subsequently
observed that session's deletion. It can establish or advance the Conversation's
resume pointer only in a qualifying `done` or `interrupted` terminal transaction.
An SDK initialization id and subagent-only mirrors do not count, and a
`mirror_error` disqualifies the Run's evidence.
_Avoid_: SDK result id, initialization id, transcript contents

**Split runtime**:
The target architecture: the agent loop runs in trusted Fargate workers
while untrusted filesystem and shell execution stays in E2B.

**Prototype path**:
The superseded daemon-based architecture — agent loop inside the sandbox,
gateway, per-turn tokens, sandbox leases. Decommissioned by hard swap; never
a fallback.
