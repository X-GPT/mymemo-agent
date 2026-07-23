---
status: accepted
---

# Interrupt Runs without ending Conversation continuity

This ADR is the implementation source of truth. Earlier
cancellation-to-interruption planning notes are superseded wherever they differ
from this accepted decision.

A user interruption ends only the targeted Run with the `interrupted` Outcome;
it does not terminate the Conversation, Agent session, or Workspace. Postgres is
the race's linearization point: if `interrupt_requested` or `interrupted` commits
before the worker's `done`/`error` terminal transaction, interruption wins and
prevents Downloadable artifact publication; if `done` or `error` commits first,
a later interruption conflicts. Permanent Conversation history retains every Run
event committed before interruption and excludes the provisional open response.

That append-only rule includes a queued Run's already-committed User message.
When such a Run is interrupted before claim, history shows the submitted message
and its `interrupted` Outcome even though Claude never received it; MyMemo does
not copy it into the Agent session or delete it from the user's record.

It also permits a committed Tool invocation to have no Tool result when
interruption stops execution before the Tool returns. History preserves the
invocation and then the `interrupted` terminal event; it does not fabricate a
`Tool failed` result for user-directed control.

Agent-session transcript entries continue to mirror directly into
`agent_sessions` under the current session id; MyMemo does not stage, fork, or
roll back a turn's private transcript. Claude Code owns whether a transcript
tail from an interrupted or errored Run is resumable. This deliberately permits
internal context absent from permanent Conversation history to influence a later
Run.

Workspace continuity has the same no-rollback boundary. Aborting Tool/E2B work
stops active processes but preserves the sandbox filesystem as it actually
stands, including partial file changes from a command interrupted mid-write. A
later Run may inspect or repair that state. Interruption prevents Downloadable
artifact publication for the Run; it does not provide filesystem transactions
or restore a pre-Run snapshot.

Direct mirror appends are fenced by the Run's active status, `locked_by`, and
unexpired `locked_until`, just like other worker writes. Entries accepted before
ownership expires remain in the transcript; appends from a worker after it loses
ownership are rejected. This fence establishes authority, not perfect worker
health: a dead, paused, partitioned, or merely delayed worker can look the same
to its peers, so a heartbeat lease defines when its write authority ends.

The same atomic fence applies when the SDK asks its SessionStore to delete a
session or subpath; trusting Claude Code's transcript-management semantics does
not authorize a stale worker to mutate shared continuity. Conversation-deletion
cleanup is a separate administrative path and may delete all transcripts after
the Conversation is gone without impersonating an active Run owner.

The mirror fence accepts both `running` and `interrupt_requested`. Recording an
interruption closes durable user-visible model-content appends and Downloadable
artifact publication immediately, but the owning worker may still flush private
SDK transcript entries and perform interruption cleanup until the terminal
transaction commits or its lease expires. Restricting mirror writes to `running`
would turn an ordinary stop-time flush into a false `mirror_error`.

The existing Postgres Run doorbell is generalized beyond queued inserts: the
committed transition to `interrupt_requested` also emits a best-effort wake-up,
which triggers the worker's normal tick to re-read owned Run state and call the
SDK stop mechanism. PostgreSQL delivers the notification only after commit; its
payload is advisory rather than authority. The normal database heartbeat remains
the fallback when a notification is delayed or lost, and notification delivery
is not itself the interruption's acceptance point.

After observing `interrupt_requested`, the owner calls `Query.interrupt()` and
allows at most 30 seconds for a clean SDK stop. If it does not settle, the worker
calls `Query.close()` to terminate the underlying CLI process and resources,
records the forced close internally, and still commits the already-accepted
`interrupted` Outcome if its ownership fence still passes. Ownership loss instead
leaves terminalization to recovery. The Run remains active and blocks new
admission during that bounded stop period; all public-content, artifact, and
stale-owner fences continue to apply.

Postgres acceptance and Redis publication are not a distributed transaction. A
provisional Live text delta already in flight may therefore appear after the
interruption was accepted. The system does not add cross-store coordination to
eliminate that narrow race: durable append fences keep the delta out of permanent
Conversation history, and clients discard the open preview after receiving the
interruption response, observing a terminal event, or recovering terminal state
from history.

An observed `mirror_error` stops model and tool execution and makes a still-
`running` Run end as `error`; MyMemo does not attempt transcript repair. If
Postgres already recorded `interrupt_requested`, that earlier durable user
control wins and the Run ends as `interrupted`. A mirror error never establishes
a first Agent-session pointer, while an existing pointer and any transcript
prefix already written under it remain for Claude Code to resume. Establishing
a first usable pointer, when possible, shares the ownership-fenced terminal
transaction with the Run Outcome.

This stop is immediate worker behavior rather than deferred result bookkeeping:
on the SDK's `mirror_error` stream message, the processor aborts the Run-scoped
controller that cancels active Tool/E2B work and invokes `Query.interrupt()` to
stop model execution. The same 30-second clean-stop limit and `Query.close()`
fallback apply. It still returns the neutral stream disposition and observed
session metadata so the supervisor can reconcile the final Outcome against
Postgres.

Interruption does not wait for SDK initialization. If the first Run is stopped
before an Agent session is established and mirrored, it still becomes
`interrupted` promptly and the next Run starts a fresh Agent session; continuity
preserves established session state rather than manufacturing state that never
existed.

An SDK initialization message carrying a session id does not by itself establish
a usable first resume pointer. The worker may publish that first pointer only
after at least one entry for the main session (the empty subpath), rather than
only a subagent transcript, has been mirrored successfully. If interruption wins
before that condition is met, the pointer remains empty and the next Run starts
fresh. An already-established pointer remains usable under the direct-continuation
policy described above.

`Query.interrupt()` remains the cause-blind SDK mechanism used to stop model
execution. The stream processor reports only a neutral `stopped` disposition
plus observed session metadata; it does not receive or infer a domain stop
cause. The Run supervisor reconciles its local abort state with the durable Run
status and alone maps a durable user interruption to `interrupted`; absent that
state, shutdown maps to `error`, ownership loss permits no terminal write, and
sandbox-renewal failure remains an error. Stream-layer names follow the same boundary—`QueryInterruptedError`
becomes `QueryStoppedError`, reserving “interruption” for the user-directed Run
control and Outcome while retaining `interrupt()` only as the vendor SDK verb.

The cutover removes `canceled` from the Run domain rather than splitting the
Outcome by timing. A queued Run transitions directly to `interrupted`; a running
Run transitions through `interrupt_requested` before the owning worker commits
`interrupted`. Both produce the same durable `run_interrupted` event. Cancellation
vocabulary remains only for internal command or process cleanup where Bash or
E2B work is actually killed.

The canonical control surface is
`POST /v1/conversations/:conversationId/runs/:runId/interrupt`; the former
`/cancel` endpoint is removed. Until the legacy Conversation-event surface is
removed under issue #344, `{ type: "user.interrupt", runId }` remains a second
transport entry point. Both routes call the same ownership-scoped interruption
operation and therefore share validation, idempotency, race, and response
semantics; the legacy route does not implement a second state machine.

Interruption is retry-safe across its terminal transition. A queued Run returns
`202 { status: "interrupted" }`; a running Run returns
`202 { status: "interrupt_requested" }`; another request while it remains in that
state returns the same response; and either initial response may later be retried
as `202 { status: "interrupted" }` after the user interruption wins. A Run
already terminalized as `done` or `error` returns `409`, while a missing or
foreign Run remains ownership-safe `404`.

`interrupt_requested` remains an active Run state. The owning worker retains its
lease while stopping model and Tool execution, and the one-active-Run invariant
continues to reject admission of another Run for that Conversation. Only the
durable transition to `interrupted` releases that backpressure. A queued Run is
already terminalized inside the interruption request and therefore releases it
immediately. This prevents the outgoing and incoming Runs from concurrently
mutating the same Agent session or Workspace.

If that owner disappears after `interrupt_requested` commits, stale-Run recovery
finishes the already-accepted user control by transitioning the Run to
`interrupted` and appending `run_interrupted`; it does not reclassify the Run as
an error. Recovery never establishes or changes an Agent-session pointer because
it lacks both current ownership and the processor's mirror-health evidence. The
existing pointer, if any, remains unchanged until a later owned Run succeeds.

Live terminal publication follows the existing general rule rather than an
interruption-specific exception. Postgres Run history and Outcome commit first
and are authoritative; only an owning worker may produce a Live Stream, so every
Live terminal event is best-effort after that durable commit. A non-worker
terminal transition—chat-api interrupting a queued Run or recovery terminalizing
stale work—writes durable history only. Consequently `run_interrupted` is
guaranteed for every interrupted Run and projects as `RUN_INTERRUPTED` in
Conversation history, while a Live `RUN_INTERRUPTED` exists only when an owning
worker has a usable Stream and its post-commit publication succeeds. Chat-api
does not gain Stream-write credentials or a synthetic producer role.

The exact custom terminal extension is
`{ type: "RUN_INTERRUPTED", threadId: string, runId: string }`; it never exposes
an Agent-session id. `RUN_ERROR` would misclassify expected user control as a
failure. AG-UI's `RUN_FINISHED.outcome.type = "interrupt"` represents a pending
agent/HITL interruption that a later Run resolves, not termination of the active
Run, so it is intentionally not reused.

Clients reconcile the authoritative terminal Outcome from Conversation history;
they never infer it from the presence or absence of a Live terminal event. EOF
before a terminal frame remains a transport failure—not a Run `error`, successful
completion, or permission to wait forever—and enters the existing generic
Reconnecting or Recovering flow. A reconnect to any terminal Run with no usable
Stream receives the same `410 { recovery: "history" }` response regardless of
whether the Stream never existed, failed, or expired. This covers an observer in
another tab or device that did not receive the initiating interruption response.

Until issue #344 removes the legacy Postgres-to-SSE projector, its exact terminal
frame is `{ type: "interrupted" }`. It maps `run_interrupted` to that frame and
then closes, replacing the old `{ type: "canceled" }` wire vocabulary; it does
not expose the internal `interrupt_requested` transition as an SSE event.

Under the claim-once protocol a queued Run has no Stream because Stream creation
happens only after claim. A future requeue design may expose a stale prior-attempt
Stream, but it does not change producer ownership: chat-api still does not append
a queued terminal frame, and the client still recovers from durable history.

Because the feature is unreleased and no existing Agent data must survive the
cutover, deployment uses a one-time destructive pre-release reset rather than
translating legacy cancellation rows. This is an operational cutover step, not
new recurring product cleanup machinery. There is no status/event backfill and
no compatibility period in which old and new Run vocabularies coexist. Existing
Agent-domain rows are discarded. No clients use the API and no worker workload
must be drained at cutover: the idle old processes are stopped before the reset,
then the new schema and binaries start after it. During that reset, cleanup
ledgers remain available only long enough to delete any referenced E2B sandboxes
and private artifact objects; then the ledgers are discarded with the other old
data.
