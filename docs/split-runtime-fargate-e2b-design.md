# Split Runtime Design: Fargate Agent Workers + E2B Executors

## Purpose

This document defines the target split-runtime architecture for moving the
agent control loop out of the E2B sandbox and into trusted Fargate workers,
while keeping untrusted filesystem and shell execution inside E2B.

The design is motivated by one primary problem in the current E2B-template
model:

> Daemon, agent, and Claude Code binary upgrades require a new E2B template,
> warm-sandbox drain, and workspace rehydration.

The split-runtime design decouples agent/runtime upgrades from E2B template
upgrades. Fargate becomes the volatile, frequently deployed agent runtime. E2B
becomes the persistent remote workspace and shell executor.

## Decision Summary

Use Fargate for trusted agent orchestration:

- `chat-api`
- separate `agent-worker` service
- Claude Agent SDK / Claude Code runtime
- OpenRouter credentials for the Claude Code / Claude Agent SDK model path
- direct document-query credentials
- document scope enforcement
- Postgres-backed run polling and run-event writing

Use E2B for untrusted execution:

- persistent conversation workspace files
- shell commands
- file read/write/search operations
- test execution
- package installs
- generated code execution

Do not run model-controlled `bash` in Fargate.

## Goals

- Allow agent and Claude Code upgrades through normal Fargate container deploys.
- Keep provider keys and database credentials out of E2B.
- Keep arbitrary shell execution inside an isolated sandbox.
- Preserve per-conversation workspace isolation.
- Support response streaming even when work is processed by separate workers.
- Scale agent workers horizontally with bounded concurrency.
- Use Postgres as the first queue, run-event log, and live stream signal.
- Avoid workspace sync by relying on persistent E2B workspaces.

## Non-Goals

- Replacing E2B immediately with self-managed Firecracker, gVisor, ECS, or
  Kubernetes sandboxes.
- Making EKS the default runtime.
- Hot-swapping the Claude Code binary inside live E2B sandboxes.
- Using generic remote shell access without conversation/run binding.
- Treating Pub/Sub notifications as durable event storage.

## High-Level Topology

```text
client
  -> chat-api on ECS Fargate
      -> Postgres: conversations, conversation_runtime, runs, run_events
      -> agent-worker on ECS Fargate
          -> OpenRouter Anthropic Messages-compatible API
          -> scoped direct document queries
          -> E2B sandbox through E2B SDK/API
              -> persistent workspace files
              -> bash
              -> read/write/search
```

`chat-api` and `agent-worker` are separate ECS Fargate services. They coordinate
through Postgres instead of direct HTTP dispatch.

The target runtime is:

```text
chat-api:
  request validation, run creation, SSE projection

agent-worker:
  Postgres-backed run polling, Claude loop, MCP tool handlers, E2B SDK client

E2B:
  persistent workspace, bash, file substrate
```

## Runtime Responsibilities

### `chat-api`

Responsibilities:

- Own the public/internal HTTP and SSE conversation API.
- Validate identity headers.
- Create conversations and freeze document scope.
- Create one `runId` per backend execution attempt.
- Enforce one active turn per conversation.
- Create queued runs in Postgres.
- Record explicit cancellation requests for active runs.
- Stream run events to the client.
- Persist conversation and run metadata.
- Coordinate cancellation and retry.

`chat-api` must not execute model-controlled shell commands.

### `agent-worker`

Responsibilities:

- Poll or receive queued runs.
- Load conversation scope and run metadata.
- Start the Claude Agent SDK loop.
- Maintain per-run agent state in memory.
- Call OpenRouter directly for Claude Code / Claude Agent SDK model traffic.
- Query scoped documents directly.
- Implement MCP tool handlers backed by the E2B SDK/API.
- Append durable run events.
- Publish live event notifications.
- Heartbeat running jobs.
- Mark runs `done`, `error`, or `canceled`.

One worker task can handle multiple conversations concurrently, but each run
must have isolated state:

- `userId`
- `conversationId`
- `runId`
- frozen document scope
- E2B sandbox binding
- tool client
- cancellation controller
- live Claude SDK `Query` handle
- supervised SDK consumer task
- event sink

Turns for the same conversation remain serialized.

### E2B Sandbox Substrate

Responsibilities:

- Host the persistent conversation filesystem.
- Run arbitrary shell commands.
- Provide file and command operations through the E2B SDK/API.
- Stream command output.
- Run with no provider keys, database credentials, or broad document secrets.

The E2B template contains only stable runtime infrastructure:

- filesystem/search utilities such as `rg`
- shell/runtime dependencies required for user code
- no Claude Code binary
- no agent loop
- no custom executor daemon in v1
- no provider credentials
- current E2B template builder/runtime with snapshot support

All split-runtime E2B templates are rebuilt with the current E2B SDK/template
builder before launch. There is no legacy-template migration path in this
design.

## Executor Tool Surface

The Claude-visible tool surface stays small, close to Claude Code's local tool
model. The model does not see process-management internals.

Initial model-facing MCP tools:

```text
Read(path)
Write(path, content)
Edit(path, oldText, newText)
Bash(command, cwd?, timeout?)
Grep(pattern, path?, include?, maxResults?)
Glob(pattern, path?, includeHidden?, maxResults?)
SearchDocuments(query, maxResults?)
```

`Grep` and `Glob` are included because their inputs can stay simple and
path-scoped. They are not required for expressiveness because the model can
achieve them through `Bash`, but dedicated tools give cleaner path enforcement,
structured output, and better audit logs.

`SearchDocuments` is a model-facing MCP tool, but the database access behind it
is trusted worker code, not an MCP server talking directly to Postgres.

Suggested schemas:

```ts
type ReadInput = {
	path: string;
	offset?: number;
	limit?: number;
};

type WriteInput = {
	path: string;
	content: string;
};

type EditInput = {
	path: string;
	oldText: string;
	newText: string;
};

type BashInput = {
	command: string;
	cwd?: string;
	timeoutMs?: number;
};

type GrepInput = {
	pattern: string;
	path?: string;
	include?: string;
	caseSensitive?: boolean;
	maxResults?: number;
};

type GlobInput = {
	pattern: string;
	path?: string;
	includeHidden?: boolean;
	maxResults?: number;
};

type SearchDocumentsInput = {
	query: string;
	maxResults?: number;
};
```

Defaults:

```text
path: conversation workspace root
maxResults: bounded by executor config
timeoutMs: bounded by executor config
Edit: replace all exact matches
Grep: ripgrep-compatible regex, case-sensitive by default
Glob: command-backed filesystem glob, hidden files excluded by default,
  lexicographic order
```

Initial system caps:

```text
Read: line-windowed reads, with an absolute byte cap
Bash: default timeout 5 minutes, system max 15 minutes
Grep: max 100 matches unless lowered by the model
Glob: max 500 paths unless lowered by the model
SearchDocuments: max bounded by worker config
```

The model may ask for lower limits, but the system owns the upper bounds.

`Grep` uses `rg` installed in the E2B template. The `agent-worker` tool handler
maps inputs to `rg` command arguments and enforces max
result/output caps even if the model asks for more.

`Glob` is command-backed inside E2B, not implemented by recursively listing the
remote filesystem into `agent-worker`. Without an in-sandbox daemon, worker-side
library globbing would require many remote file-listing calls. Use a bounded
shell/Python/Node command inside the sandbox, scoped to the workspace root, and
return deterministic sorted relative paths.

The `agent-worker` MCP tool handlers will need richer internal code, but those
capabilities are not exposed as separate model-callable tools:

```text
spawn process
stream or collect stdout/stderr
enforce timeout
cancel process and descendants on user stop
return exit code and bounded output
normalize and validate paths
enforce workspace root
truncate large file and command outputs
record audit events
report health/version to the worker
track workspace dirty state
```

Do not expose separate model-facing tools such as `kill_command`,
`get_command_output`, or `get_runtime_info` in the first version.

- `kill_command` is an internal cancellation capability. It must be controlled
  by the worker/executor because the model is blocked while a `Bash` call is
  running.
- `get_command_output` is only needed for a future asynchronous command model
  where commands outlive a single `Bash` call or output must be reattached after
  reconnect.
- `get_runtime_info` is not a v1 tool. The worker uses an internal
  health/version check for compatibility gates.
- workspace persistence is provided by E2B, so no normal per-turn
  `sync_workspace` tool or protocol step is required.

Every model-facing tool call and internal E2B SDK/API action must be bound to:

- `userId`
- `conversationId`
- `runId`
- `sandboxId`
- active run owner
- workspace root
- timeout and output limits
- audit event

The worker's tool handlers must reject path traversal and paths outside the
conversation workspace before issuing E2B SDK/API calls.

### Bash Execution

Use E2B's command APIs for remote process execution:

- foreground commands return a final result with exit code and bounded output
- background commands are not supported in v1
- stdout/stderr streams from E2B to `agent-worker`
- command timeout uses the E2B `commands.run(..., { timeoutMs })` primitive
- user cancellation uses E2B running-command handles/listing and
  `commands.kill(pid)`
- `Bash` marks the workspace dirty conservatively because even failed
  commands can mutate files

E2B's JavaScript SDK v2.6.0 documents the primary v1 executor primitives:
`commands.run` supports `onStdout` / `onStderr` streaming callbacks and
`timeoutMs`; background commands return a handle; running commands can be listed,
reconnected with `commands.connect(pid)`, and killed with `commands.kill(pid)`.
Use these as the default implementation path before adding any in-sandbox
executor daemon.

The model only sees the `Bash` tool. It does not call `kill_command` directly.
V1 keeps `Bash` foreground-only, but foreground-only must be enforced by the
executor, not by command syntax checks alone. Rejecting obvious detached forms
such as `&`, `nohup`, `setsid`, and watcher-style commands is useful for user
feedback, but it is not a correctness boundary. Shells, package-manager
scripts, test runners, and child processes can still create descendants that
survive the parent process.

The remaining E2B command-semantics validation is process-tree cleanup. The SDK
reference documents `commands.kill(pid)` as killing a PID, but the design must
not assume this also kills every descendant. Before snapshotting or emitting a
successful terminal event, the worker must prove that timeout/cancellation
cleanup covers child processes, or run each `Bash` command through a small
sandbox-side wrapper that creates an owned process group/session and kills that
group on timeout, cancellation, or stale-run recovery.

Command execution requirements:

- each command runs under an executor-owned command id
- each command is attached to the active `{runId, workerId, sandboxId}`
- each command runs in a process group/session/cgroup-equivalent boundary if
  E2B kill/timeout semantics do not already cover descendants
- timeout and cancellation kill the whole command tree, not only the shell
  parent
- the worker records command start, finish, timeout, cancellation, exit code,
  and bounded stdout/stderr
- after every command returns, times out, or is canceled, the worker verifies
  that no managed descendant remains for that command before continuing

Snapshot and terminal-event requirements:

- no snapshot may start while a managed command is still running
- no `done` event may be emitted until command cleanup and the snapshot
  checkpoint barrier have both completed
- if command cleanup cannot prove the sandbox is clean, the worker must fail the
  run and mark the sandbox tainted instead of snapshotting potentially
  unstable files

Long-running services and detached jobs require a future tracked-process model
with explicit process ownership, cancellation, output reattachment, and
checkpoint barriers. That future model should expose separate tools such as
`GetCommandOutput`, `StopCommand`, and `ListCommands`; it is not part of v1.

## Conversation And Run Model

Use the existing product vocabulary:

- `conversationId`: durable user-visible conversation.
- `runId`: one backend execution attempt.
- `agentSessionId`: Claude SDK session id, internal/runtime-facing.
- `sandboxId`: E2B sandbox serving file/shell operations.

Only one run may be active for a conversation at a time.

Different conversations may run concurrently in the same Fargate worker task if
the worker has capacity.

Different runs for the same conversation may be handled by different workers
over time. A conversation is not permanently pinned to a worker. While a run is
active, however, that run's `locked_by` worker is the only process that owns the
live Claude SDK `Query` handle, cancellation controller, active E2B command
handle, and in-memory tool state for that run.

This must be enforced at run creation, not only by worker discipline. The `runs`
table rejects more than one non-terminal run for the same
`{userId, conversationId}`:

```sql
CREATE UNIQUE INDEX runs_one_active_per_conversation
ON runs (user_id, conversation_id)
WHERE status IN ('queued', 'running', 'cancel_requested');
```

`POST /v1/conversations/:conversationId/events` creates the run in a
transaction before opening the SSE stream. If this insert violates the active
run index, return the existing busy/backpressure response before any stream is
opened.

### Conversation Event API

The conversation events endpoint keeps the existing event-envelope shape:

```ts
type ConversationEventBody =
	| { type: "user.message"; text: string }
	| { type: "user.interrupt"; runId: string };
```

The two events share validation, identity headers, and conversation ownership
checks, but they do not have the same runtime behavior:

- `user.message` is a turn-producing event. It creates a new `runId`, inserts a
  queued run, and opens/projects the SSE stream for that run.
- `user.interrupt` is a control event for an existing queued or running run. It
  must not create a new run, must not be sent to Claude as a normal user
  message, and must not be claimable by an arbitrary worker.

`user.interrupt` targets the existing run named by `runId`:

```text
queued run:
  chat-api transitions queued -> canceled and appends run_canceled

running run:
  chat-api records cancel_requested_at and sets status = cancel_requested
  chat-api sends pg_notify(runId) as a wake-up optimization
  owning worker observes the cancel request and calls Query.interrupt()
```

`user.interrupt` returns after the cancellation request is durably recorded. The
client-visible terminal result is still delivered through the run's SSE
projection as `canceled`. Closing the SSE connection is not cancellation.

Response shape:

- queued run canceled immediately: `202 { runId, status: "canceled" }`
- running run cancellation requested: `202 { runId, status: "cancel_requested" }`
- missing run or run owned by another member: `404`
- already terminal run: `409 { runId, status }`

The endpoint conditionally returns different response types by event type:
`user.message` opens `text/event-stream`, while `user.interrupt` returns JSON and
does not open a new SSE stream. Clients should keep reading the original run's
SSE stream for the eventual `canceled` frame.

SSE reconnect must not create a new run. Add a read-only run stream endpoint for
replay and live continuation of an existing run:

```text
GET /v1/conversations/:conversationId/runs/:runId/events
```

The reconnect endpoint validates the same identity headers and conversation
ownership, verifies the run belongs to the conversation, and projects existing
`run_events` from the `Last-Event-ID` cursor. It does not accept user input, does
not enqueue work, and does not change run state. A reconnecting client should use
this endpoint instead of re-posting the original `user.message`; re-posting a
message would create a new backend attempt or hit the active-run busy guard.

Do not depend on a specific Claude SDK final message shape after
`Query.interrupt()`. Cancellation is app-owned state. Once `cancel_requested` is
durably recorded, any later SDK result is ignored for success purposes; SDK
errors after cancellation are mapped to `canceled`.

## Dispatch Model

Use a Postgres-backed run queue. `chat-api` and `agent-worker` are separate
services; workers pull queued runs from Postgres when they have local capacity.

```text
runs.status = queued | running | cancel_requested | done | error | canceled
workers claim queued runs through claimNextRunTx with FOR UPDATE SKIP LOCKED
```

Claim pattern:

```sql
WITH candidate AS (
  SELECT id
  FROM runs
  WHERE status = 'queued'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE runs
SET status = 'running',
    locked_by = $1,
    locked_until = now() + interval '60 seconds',
    heartbeat_at = now()
FROM candidate
WHERE runs.id = candidate.id
  AND runs.status = 'queued'
RETURNING runs.*;
```

`claimNextRunTx(workerId)` owns this transaction. Do not implement queue claim
as a separate select followed by an update in application code; the select,
status recheck, ownership write, and returned claimed row must be one
transactional helper so two workers cannot race through a stale candidate.

Workers heartbeat every 15 seconds while a run is active.

Failed runs must not retry automatically in the first version. Mark the run
`error`, append an error event, clear its ownership fields, and let the user
retry. If a worker dies and `locked_until < now()`, the recovery loop marks the
stale run terminal and appends the terminal event in the same transaction. Use
`canceled` when cancellation was requested; otherwise use `error`.

Stale-run recovery must also handle E2B side effects. Database fencing prevents a
stale worker from appending events or overwriting runtime metadata, but it does
not by itself stop an old remote command from mutating the persistent E2B
workspace. When recovery terminalizes a stale run, the sandbox associated with
that run is tainted until cleanup proves otherwise.

Recovery behavior:

- cancel/list active commands through E2B if the API supports it
- kill the sandbox when active command cleanup is unavailable or inconclusive
- clear or quarantine `conversation_runtime.sandbox_id` with a fenced update
- force the next turn to restore from `latest_snapshot_id` when the sandbox was
  killed or marked tainted
- never create a new snapshot from a sandbox after stale-run recovery unless the
  worker can prove no stale command remains

Cancellation is explicit run state, not an out-of-band stream close:

```text
queued -> canceled
running -> cancel_requested -> canceled
```

Cancellation rules:

- Canceling a queued run uses a compare-and-set update from `queued` to
  `canceled`, appends `run_canceled`, and clears ownership fields in one
  transaction.
- Canceling a running run uses a compare-and-set update from `running` to
  `cancel_requested`, sets `cancel_requested_at = now()`, and leaves
  `locked_by` unchanged.
- The owning worker observes `cancel_requested`, calls Claude SDK
  `Query.interrupt()`, cancels any active E2B command, may append owned
  cancellation cleanup/audit events, appends `run_canceled`, and transitions the
  run to `canceled` in one terminal transaction.
- If the owning worker has died and `locked_until < now()`, stale-run recovery
  may terminalize the run. Prefer `canceled` if cancellation was requested;
  otherwise use `error`.
- A worker must check for `cancel_requested` before emitting `done`; successful
  completion loses to a recorded cancellation request.
- After a run enters `cancel_requested`, the owning worker must not append more
  assistant text, successful tool results, or normal SDK content events. It may
  append bounded cleanup/audit events needed to prove what happened during
  cancellation, such as `model_interrupt_requested`, `command_cancel_requested`,
  `command_canceled`, `command_cleanup_failed`, `command_cleanup_complete`, or
  `sandbox_tainted`.

Do not introduce a generic conversation-event inbox in v1. The only mid-run
control event in v1 is cancellation, and the `runs` row is the simplest source
of truth for that state. If future features add tool confirmations, approvals,
or other multi-step user inputs, add a targeted active-run inbox then.

Benefits:

- no SQS dependency
- easy to inspect
- run state and queue state live together

Tradeoff:

- custom scaling loop required
- polling load must be controlled
- retry/visibility behavior must be implemented carefully

Initial split-runtime implementation:

```text
Postgres:
  conversations
  conversation_runtime
  runs
  run_events

Postgres LISTEN/NOTIFY:
  live wake-up for SSE streaming

No SQS initially.
```

SQS is not part of v1. Revisit queue infrastructure only after Postgres queue
metrics show it is the bottleneck.

Queue `ack` semantics alone are not enough to replace this design. The hard
requirement is active-run ownership: `user.message` can be claimed by any
worker before a run starts, but `user.interrupt` must be observed by the worker
that owns the live run. A managed queue is only a good replacement if it
preserves per-conversation active-consumer affinity or direct delivery to the
current owner while keeping Postgres as the source of truth for run status and
SSE replay.

## Agent Worker Run Lifecycle

A worker task may run multiple conversations concurrently, but every active run
is registered as explicit in-memory state:

```ts
type ActiveRun = {
	runId: string;
	conversationId: string;
	query: Query;
	abortController: AbortController;
	consumeTask: Promise<void>;
	activeCommand?: { cancel(): Promise<void> };
};
```

The worker starts Claude Agent SDK in streaming input mode so the returned
`Query` supports `interrupt()`. A one-shot string prompt is not sufficient if
mid-run cancellation is required.

The SDK output stream is consumed by a supervised task, not an untracked
fire-and-forget loop:

```ts
const q = query({ prompt: inputStream, options });

const runState: ActiveRun = {
	runId,
	conversationId,
	query: q,
	abortController,
	consumeTask: Promise.resolve(),
};

activeRuns.set(runId, runState);
runState.consumeTask = consumeQuery(runId, q);
```

The consumer owns SDK output persistence:

```ts
async function consumeQuery(runId: string, q: Query) {
	try {
		for await (const message of q) {
			await appendRunEventFromSdkMessage(runId, message);
		}

		await transitionRunDoneIfNotCanceled(runId);
	} catch (error) {
		if (await isCancelRequested(runId)) {
			await transitionRunCanceled(runId);
			return;
		}

		await transitionRunError(runId, error);
	} finally {
		activeRuns.delete(runId);
	}
}
```

A separate heartbeat/control loop runs for the same active run:

```text
while run is active:
  heartbeatRunTx(runId, workerId)
  keep E2B sandbox alive / extend timeout
  if cancel_requested_at is set:
    Query.interrupt()
    cancel active E2B command if present
```

`LISTEN/NOTIFY` wakes this loop quickly, but polling during heartbeat is the
correctness path. On worker shutdown, the worker must stop claiming new runs,
request interruption/cancellation for active runs, cancel active E2B commands,
and await or time-bound all `consumeTask`s before exit.

The heartbeat/control loop is also the E2B keepalive path. The worker must keep
the sandbox alive while it owns an active run, including model think time, tool
execution, command streaming, cancellation, and snapshot creation. The
configured E2B idle timeout is shorter than the maximum tool timeout, so a
15-minute `Bash` command is only valid if the worker renews or extends the
sandbox timeout for the whole active run.

## State Ownership

Keep execution ownership and persistent workspace pointers separate:

```text
conversations:
  product conversation record and frozen document scope

conversation_runtime:
  one row per {userId, conversationId}
  sandboxId
  latestSnapshotId
  workspaceCheckpointStatus
  runtime metadata for the persistent E2B workspace

runs:
  queue state and active execution ownership
  status = queued | running | cancel_requested | done | error | canceled
  lockedBy
  lockedUntil
  heartbeatAt
  cancelRequestedAt
  nextEventSeq

run_events:
  durable stream for SSE projection and replay

document_access_events:
  document access audit
```

The split runtime does not need a separate active conversation lease table if
the `runs` table owns execution and enforces one active run per conversation
with the partial unique index. `conversation_runtime` replaces the old
`sandbox_leases` role for long-lived sandbox/workspace pointers; it does not own
active turn execution.

Use narrow transaction helpers for run state:

```ts
appendRunEventTx(runId, type, payload);
transitionRunTerminalTx(runId, status, terminalEvent);
requestRunCancellationTx(runId, userId, conversationId);
claimNextRunTx(workerId);
heartbeatRunTx(runId, workerId);
```

All code paths that append events or move a run to a terminal state must use
these helpers so sequence allocation and terminal status changes stay
consistent.

Worker event appends must be fenced by active run ownership. There are three
event append classes:

```text
model/content events:
  status = running
  locked_by = workerId
  locked_until > now()

cancellation cleanup/audit events:
  status in (running, cancel_requested)
  locked_by = workerId
  locked_until > now()

terminal events:
  only through terminal transition helpers
```

Normal SDK content, assistant text, and successful tool-result events are
model/content events and may only be appended while the run is `running`.
Cancellation cleanup/audit events may be appended by the owning worker after
`cancel_requested` so command interruption, command-tree cleanup, and sandbox
taint decisions remain durable. Terminal helpers own `run_canceled`,
`run_failed`, and stale-run recovery. This prevents a stale worker from
appending messages after cancellation or recovery has terminalized the run while
still preserving the cancellation audit trail.

All `conversation_runtime` mutations must also be fenced by active run
ownership. A worker that stalls past `locked_until` must not later overwrite
`sandboxId`, `latestSnapshotId`, or `workspaceCheckpointStatus` after another
worker has recovered the conversation. Implement this with an ownership check
equivalent to:

```sql
UPDATE conversation_runtime
SET latest_snapshot_id = $snapshotId,
    workspace_checkpoint_status = $status,
    updated_at = now()
WHERE user_id = $userId
  AND conversation_id = $conversationId
  AND EXISTS (
    SELECT 1
    FROM runs
    WHERE id = $runId
      AND user_id = $userId
      AND conversation_id = $conversationId
      AND status = 'running'
      AND locked_by = $workerId
      AND locked_until > now()
  );
```

If the fenced update affects zero rows, the worker has lost ownership. It must
stop the run, avoid emitting success, and let stale-run recovery or the current
owner produce the terminal event.

## Response Streaming

The job queue does not stream responses.

Response streaming is supported by:

```text
durable run_events table + live Pub/Sub notification
```

Recommended first implementation:

```text
Postgres run_events table = durable ordered event log
Postgres LISTEN/NOTIFY = live wake-up signal
chat-api SSE route = projector from run_events to client frames
```

Flow:

```text
1. client sends message
2. chat-api creates run with status = queued
3. chat-api opens the SSE projector from seq = 0
4. chat-api subscribes to live notifications as a wake-up optimization
5. worker appends events to run_events
6. worker sends pg_notify(runId)
7. chat-api receives notification
8. chat-api SELECTs new events by sequence
9. chat-api sends SSE frames to client
```

Do not add a pre-queued status in v1. A worker may append events before the SSE
handler is fully listening; that is acceptable because the SSE projector always
replays from the durable `run_events` table before waiting for notifications.

If run creation hits the active-run unique index, `chat-api` returns busy in v1.
Stale active runs are cleared by the recovery loop, which must run at least every
15 seconds.

The notification payload is small:

```json
{ "runId": "..." }
```

The source of truth is always the table:

```sql
SELECT *
FROM run_events
WHERE run_id = $1
  AND seq > $2
ORDER BY seq ASC;
```

SSE reconnect uses the last event sequence:

```text
Last-Event-ID: <seq>
```

Use a dedicated Postgres connection for `LISTEN/NOTIFY`. Do not depend on
PgBouncer transaction pooling for listeners.

Run events have a monotonic per-run sequence:

```text
runs(id, next_event_seq, ...)
run_events(run_id, seq, type, payload, created_at)
unique(run_id, seq)
```

Allocate `seq` in the database, not with app-side `max(seq) + 1`. A
model/content event append increments the run counter and inserts the event in
the same transaction:

```sql
UPDATE runs
SET next_event_seq = next_event_seq + 1
WHERE id = $1
  AND status = 'running'
  AND locked_by = $2
  AND locked_until > now()
RETURNING next_event_seq - 1 AS seq;
```

Then insert `run_events(run_id, seq, type, payload, created_at)`. Worker event
appends must use the appropriate ownership fence for their append class. Owned
cancellation cleanup/audit appends may use `status IN ('running',
'cancel_requested')`; model/content appends must stay `status = 'running'`.
Terminal helpers for `run_canceled`, `run_failed`, and stale-run recovery may
use a different status/ownership predicate, but they still allocate sequence
numbers through the same transactional counter. This handles events written by
the worker, cancellation path, and stale-run recovery without sequence races.

Persist text deltas and structured lifecycle events. Persist bounded tool output
tails or summaries, not unbounded stdout/stderr.

`LISTEN/NOTIFY` is only a wake-up signal. The SSE projector must tolerate missed
notifications:

```text
loop:
  SELECT events WHERE seq > lastSeq ORDER BY seq
  stream any events found
  if terminal event seen, close
  otherwise wait for NOTIFY or a 1-2 second timeout
```

`Last-Event-ID` remains the replay cursor.

Cancellation is a client-visible terminal state:

```text
canceled — {}
```

Persist it internally as `run_canceled` and map it to the `canceled` SSE frame.
Do not overload `error` for user-initiated cancellation.

## Scaling Fargate Workers

An ECS task is the unit ECS schedules. A task can contain one or more
containers. In the normal worker setup:

```text
1 ECS Fargate task = 1 agent-worker container
```

One worker task may process multiple runs concurrently. Those runs share the
task's CPU and memory.

Example:

```text
task size: 2 vCPU / 4 GiB
targetConcurrentRunsPerTask: 2
hardMaxConcurrentRunsPerTask: 4
```

The runs share the same `2 vCPU / 4 GiB`; they do not each receive that
allocation.

### Capacity Formula

Use:

```ts
desiredTasks = Math.ceil(
	(queuedRuns + runningRuns) / targetConcurrentRunsPerTask,
);
```

Meaning:

- `runningRuns` consume worker capacity now.
- `queuedRuns` need near-future capacity.
- `targetConcurrentRunsPerTask` is the desired run concurrency per worker task.
- `Math.ceil` rounds partial capacity up to a whole Fargate task.

Example:

```text
queuedRuns = 12
runningRuns = 20
targetConcurrentRunsPerTask = 2

desiredTasks = ceil((12 + 20) / 2) = 16
```

Use a lower target than the hard maximum to preserve memory and latency
headroom.

### Scaling With Postgres Queue

ECS cannot directly autoscale from Postgres state. Add a small scaler:

```text
scheduled Lambda, cron task, or control-loop service
  -> query Postgres
  -> compute desired task count
  -> call ECS UpdateService
```

Scaler query:

```sql
SELECT
	count(*) FILTER (WHERE status = 'queued') AS queued_runs,
	count(*) FILTER (
		WHERE status IN ('running', 'cancel_requested')
		AND locked_until > now()
	) AS running_runs
FROM runs
WHERE created_at > now() - interval '1 day';
```

Scaler logic:

```ts
const desiredTasks = clamp(
	Math.ceil((queuedRuns + runningRuns) / targetConcurrentRunsPerTask),
	minTasks,
	maxTasks,
);

await ecs.updateService({
	cluster,
	service,
	desiredCount: desiredTasks,
});
```

Recommended initial settings:

```text
minTasks: 1-2
maxTasks: environment-specific
targetConcurrentRunsPerTask: 2
hardMaxConcurrentRunsPerTask: 4
scaleOutInterval: 30-60 seconds
scaleInCooldown: 10 minutes
```

Do not scale only on CPU. Agent workers often wait on model and tool I/O while
still occupying run capacity.

## Fargate Cold Starts

Do not start a fresh Fargate task for every user turn.

Fargate task startup can take tens of seconds depending on:

- image size
- ECR pull time
- subnet and ENI setup
- platform capacity
- app boot time
- secrets and logging setup

For interactive UX, use:

```text
ECS service with warm worker tasks
```

Do not use per-turn `RunTask` capacity in v1. Ordinary turns use warm ECS
service tasks.

## Workspace Lifecycle

Files still live in E2B in this design because shell commands must run where the
files are. The v1 workspace persistence strategy is:

```text
workspacePersistenceStrategy = e2b_pause_snapshot
```

The worker stores `sandboxId` and the latest successful `snapshotId` in
Postgres. E2B is the durable workspace substrate; MyMemo does not separately
sync workspace files to S3 or a separate workspace store.

Mapping:

```text
one conversation -> one persistent E2B sandbox/workspace
E2B idle timeout -> 5 minutes while no active run owns it
E2B active-run timeout -> renewed/extended by the owning worker
E2B lifecycle on timeout -> pause sandbox
E2B pause mode -> filesystem-only by default
max lifetime -> none
```

Create sandboxes with E2B lifecycle pause if the deployed E2B SDK/runtime
supports an automatic pause-on-timeout contract:

```ts
const sandbox = await Sandbox.create(templateOrSnapshotId, {
	timeoutMs: 5 * 60 * 1000,
	lifecycle: {
		onTimeout: { action: "pause", keepMemory: false },
		autoResume: false,
	},
});
```

Use `keepMemory: false` because the split runtime only needs filesystem
persistence. The agent loop and model state live in Fargate. V1 does not preserve
in-sandbox background processes across idle pause.

The exact E2B pause/snapshot API shape is a prototype gate, not an assumption to
copy blindly into production code. Before implementation, validate the deployed
E2B JavaScript SDK and template runtime with a spike that proves:

- a sandbox can pause on idle timeout without losing files
- a paused sandbox can be reconnected or resumed
- the worker can explicitly extend or renew timeout during an active run
- snapshot creation returns a reusable checkpoint id
- a fresh sandbox can be created from that checkpoint id
- timeout/cancel cleanup and snapshot creation cannot race active commands

If automatic pause-on-timeout is not available, use explicit worker-driven
pause/checkpoint calls where supported. If E2B cannot provide a durable
filesystem checkpoint with the required semantics, this design must fall back to
a separate durable workspace store instead of treating E2B as the only source of
truth for user-created files.

The 5-minute timeout is an idle policy, not a maximum turn duration. While a run
is active, the owning worker must renew or reconnect/extend the sandbox timeout
often enough that E2B does not pause during model thinking, tool execution,
command streaming, cancellation handling, or snapshot creation. If renewal
fails, the worker should stop issuing tool calls, fail or cancel the run
according to the current run state, and avoid emitting `done`.

Primary recovery path:

```text
turn starts:
  Sandbox.connect(sandboxId, { timeoutMs })
  if connect succeeds, use existing paused/running sandbox

connect fails:
  Sandbox.create(latestSnapshotId)
  store new sandboxId with a fenced `conversation_runtime` update
```

The paused sandbox is the normal durable workspace. The snapshot is a checkpoint
fallback, not the main per-turn resume mechanism.

Sandbox replacement is an external side effect followed by a fenced database
write. If a worker creates a replacement sandbox and then loses run ownership
before it can store the new `sandboxId`, it must immediately kill the newly
created sandbox. If that kill fails, record enough metadata for orphan cleanup:

```text
orphan_sandboxes:
  sandbox_id
  user_id
  conversation_id
  run_id
  created_by_worker_id
  reason
  created_at
```

Never emit `done` after a fenced `conversation_runtime` write fails.

Recommended lifecycle:

```text
1. run starts
2. worker owns the active run and loads the persistent E2B workspace/sandbox
   pointer from `conversation_runtime`
3. worker runs agent loop from Fargate
4. agent-worker tool handlers call E2B SDK/API for file/shell operations
5. run events are persisted to Postgres
6. if workspaceDirty, create/update the conversation snapshot
7. done event is emitted after the agent run, metadata writes, and snapshot finish
8. E2B auto-pauses the sandbox after the configured 5-minute timeout
```

Agent and Claude Code upgrades do not require workspace hydration because those
components live in Fargate. E2B template upgrades are rare and limited to
executor/runtime dependencies.

Active run ownership plus the partial unique index prevents two workers from
mutating the same persistent E2B workspace concurrently. V1 does not use a
separate conversation execution lease.

Store E2B metadata on the sandbox when creating it:

```text
userId
conversationId
runtime=split-fargate-e2b
```

The database run record remains the execution authority, and
`conversation_runtime` remains the workspace pointer authority. E2B metadata
makes operational lookup, debugging, and manual recovery easier.

### Snapshot Policy

Snapshots are the recovery source of truth for user-created work files. Loaded
KB document content is run context, not durable workspace state. The v1 design
does not require loaded documents to be recoverable after the run. Create
snapshots at conversation checkpoints, not after every file write.

Mark the workspace dirty when:

- `Write` succeeds.
- `Edit` succeeds.
- any `Bash` command is executed, regardless of exit code.

`SearchDocuments` does not mark the workspace dirty because document results are
not written into the durable workspace by default. If a later model-controlled
command transforms a document into user work, that transformation is captured
through `Write`, `Edit`, or `Bash` dirty tracking.

Create/update the conversation snapshot:

- after a successful turn if `workspaceDirty` is true
- before explicit worker-driven pause if that is ever added and
  `workspaceDirty` is true

Do not snapshot after every `Write`, `Edit`, or `Bash` call. The worker must
track a dirty flag and snapshot once the turn reaches a clean checkpoint.
Because E2B snapshots can interrupt active sandbox connections, snapshot only
after tool execution has finished and before emitting the final `done` event.

If `workspaceDirty = true`, the snapshot must complete and the latest
`snapshotId` must be stored durably before emitting `done` or releasing the
succeeded run. If snapshot creation or metadata persistence
fails:

- append `run_failed`
- keep the sandbox id in `conversation_runtime` if live recovery remains possible
- return a user-visible persistence error
- do not emit `done`

Recovery behavior:

```text
paused sandbox resumes:
  continue with existing filesystem and memory

paused sandbox cannot resume:
  create fresh sandbox from latest conversation snapshot ID

no snapshot exists:
  create fresh sandbox and show a user-visible recovery message
```

E2B snapshot API shape:

```text
create/update checkpoint:
  sandbox.createSnapshot()

recover:
  Sandbox.create(snapshotId)
```

The method names above are illustrative until the E2B prototype verifies the
actual SDK calls. Store the latest successful `snapshotId` on
`conversation_runtime`.

Snapshot retention policy:

```text
conversation_runtime.latest_snapshot_id = newest successful checkpoint
conversation_runtime.previous_snapshot_id = prior successful checkpoint
unreferenced snapshots older than 7 days are eligible for cleanup
```

Keep one previous snapshot so a bad checkpoint can be rolled back during manual
recovery. The product path always restores from `latest_snapshot_id`; use
`previous_snapshot_id` only for operator-driven recovery.

Paused sandbox cleanup policy:

- Paused sandboxes may live as long as their conversation exists.
- Conversation deletion, user deletion, or workspace deletion must explicitly
  kill the referenced E2B sandbox and clear `conversation_runtime.sandbox_id`.
- A periodic cleanup job should kill sandboxes referenced by runtime rows whose
  conversation/user no longer exists.
- A periodic orphan cleanup job should kill sandbox IDs recorded in
  `orphan_sandboxes` after verifying they are not the current
  `conversation_runtime.sandbox_id`.
- Cleanup failures should be retried; they should not block user-facing run
  completion unless the run itself created the orphan and still owns it.

Snapshot failure state:

```text
runs.status = error
run_events includes run_failed with persistence_error
conversation_runtime.sandbox_id remains if live/reconnectable
latest_snapshot_id remains the previous successful checkpoint
workspace_checkpoint_status = dirty_uncheckpointed
```

The next turn must first try to reconnect to the dirty sandbox and checkpoint
it. If that fails, restore from the previous snapshot and tell the user the last
turn's uncheckpointed workspace changes were lost.

## Credential Model

Trusted Fargate holds:

- OpenRouter API credentials for model traffic
- read-only document DB credentials or scoped backend document credentials
- AWS credentials through task IAM role
- E2B API credentials

E2B holds:

- no provider API keys
- no database credentials
- no broad document credentials
- only per-run executor metadata that cannot grant provider or document access

`agent-worker` uses two separate Postgres connections with separate credentials,
roles, schemas, and migration ownership:

```text
AGENT_DATABASE_URL  # writable mymemo_agent DB: conversations, runs,
                    # run_events, conversation_runtime, worker state
KB_DATABASE_URL     # read-only mymemo_kb DB: document search/fetch only
```

Do not use a generic `DATABASE_URL` in `agent-worker`. The current repo has two
database trust domains: chat/run state in the writable `mymemo_agent` database,
and knowledge-base documents in the read-only KB database. Naming must preserve
that boundary.

Drizzle usage:

- Drizzle owns schemas and migrations for `AGENT_DATABASE_URL`.
- The KB schema is read-only from the worker's perspective; use generated or
  hand-written read models, but do not let worker migrations own KB tables.
- Create separate clients, for example `agentDb` and `kbDb`; do not pass a
  generic `db` into shared code.
- Use a narrow raw-SQL transaction layer for concurrency-critical helpers such
  as `claimNextRunTx`, `appendRunEventTx`, `transitionRunTerminalTx`,
  `requestRunCancellationTx`, `heartbeatRunTx`, and `LISTEN/NOTIFY`.

Moving `KB_DATABASE_URL` into `agent-worker` is an intentional trust-boundary
change from the current gateway-only KB credential model. The worker is trusted
infrastructure, but this increases credential blast radius across every running
worker task. Keep all KB access behind a narrow shared query/scope module and do
not expose raw SQL or database credentials to MCP tools.

Direct KB access requirements:

- Use a least-privilege, read-only KB database role for `agent-worker`.
- Expose only named document query functions from the shared module; do not pass
  a generic DB handle into MCP/tool code.
- Reuse parameterized SQL from the gateway document module or an extracted shared
  module; do not construct ad hoc SQL in tool handlers.
- Apply query timeouts and statement timeouts.
- Apply row limits, excerpt limits, and total response-size limits.
- Audit full-document or excerpt loads with `runId`, `conversationId`, `userId`,
  scope, document IDs, and query metadata.

Document scope enforcement moves to trusted Fargate worker logic. Scope must be
frozen at conversation creation and re-read from the conversation record on each
run before any direct document query is issued.

Direct document queries must be implemented through a narrow data-access module
in `agent-worker`, not ad hoc SQL in tools. That module accepts the frozen scope
and query text, then applies scope constraints server-side before returning
bounded snippets or document excerpts to the agent loop.

Extract the existing gateway document query and scope-guard logic into a shared
package or shared internal module so `agent-worker` reuses the same
parameterized SQL and scope rules with its own `KB_DATABASE_URL`.

The model-facing document tool is:

```text
SearchDocuments(query, maxResults?)
```

Implementation path:

```text
Claude / Agent SDK
  -> MCP tool: SearchDocuments
      -> agent-worker document module
          -> KB Postgres through KB_DATABASE_URL
          -> returns scoped snippets or bounded excerpts
```

Result shape:

```ts
type SearchDocumentsResult = {
	documents: Array<{
		documentId: string;
		title: string;
		snippet: string;
		score?: number;
	}>;
};
```

Do not write loaded document content into the E2B workspace by default. V1
treats document search results as current-run model context only. Do not store
full document content in run events, audit rows, snapshots, or durable
conversation metadata by default. If a user explicitly asks the agent to create
a derived file from a document, that derived file is normal workspace state and
is included in snapshots.

Document access audit is stored in Postgres:

```text
document_access_events
  id
  run_id
  conversation_id
  user_id
  scope_type
  scope_id
  query
  document_ids
  created_at
```

Also append a lightweight run event for debugging and replay context:

```json
{
  "type": "document_search",
  "query": "...",
  "documentIds": ["..."]
}
```

Do not store full document content in audit rows by default.

## Model Provider Path

The target model path is direct OpenRouter access from `agent-worker`.

```text
Claude Code / Claude Agent SDK in agent-worker
  -> OpenRouter Anthropic Messages-compatible API
```

Expected worker configuration:

```text
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<OPENROUTER_API_KEY>
ANTHROPIC_API_KEY=""
```

OpenRouter's Claude Code integration guide documents this environment-variable
path. Keep the exact variable names required by the Claude Code / Claude Agent
SDK version being deployed; the key design point is that the provider credential
lives in trusted Fargate, not in E2B. For Claude Code compatibility, configure
OpenRouter provider routing so Anthropic first-party models have priority, as
recommended by the OpenRouter guide.

The gateway is not in the v1 model path. Model traffic goes directly from
`agent-worker` to OpenRouter. Provider policy in v1 is implemented in
`agent-worker` configuration: one allowed default OpenRouter model and no
provider fallback.

Because v1 bypasses the gateway, `agent-worker` owns the replacement provider
controls:

- model allowlist and default model rewrite
- required OpenRouter attribution headers
- request logging with `userId`, `conversationId`, `runId`, model, latency, and
  terminal status
- per-run model timeout and cancellation propagation
- coarse spend/rate-limit hooks, even if the first implementation only logs or
  fails closed after a configured budget
- explicit provider error policy: no provider fallback in v1; fail closed and
  emit a user-visible run error

Before relying on direct OpenRouter in production, run an end-to-end deployment
smoke test with the exact Claude Code / Claude Agent SDK version:

- normal streaming response
- tool-use turn with `Bash` and file tools
- cancellation while a tool call is running
- long-context request
- any token-counting or prompt-cache behavior the SDK invokes

## Security Requirements

- Every E2B SDK/API call must be authenticated and bound to a specific run.
- The worker must verify it owns the active run before issuing E2B SDK/API
  calls.
- Executor tokens are short-lived and scoped to one sandbox/run when
  possible.
- The worker tool handlers must enforce a workspace root before issuing E2B
  SDK/API calls.
- Command execution must have timeout and output limits.
- Cancellation must stop model generation and remote commands.
- Run events must record tool calls and command lifecycle events.
- Workers must not share mutable agent state across conversations.
- The same conversation must not run concurrently on two workers.

## Cost Model

The split runtime is not automatically cheaper.

Current model:

```text
cost ~= E2B sandbox runtime + chat-api/gateway baseline
```

The current baseline includes the gateway because the agent runs in E2B and
must not hold provider credentials. The target split runtime does not require
the gateway for model traffic because `agent-worker` is trusted Fargate.

Split model:

```text
cost ~= Fargate agent worker runtime + E2B sandbox runtime + Postgres
```

The split model wins operationally when it reduces:

- E2B template rebuild frequency
- forced sandbox drain
- workspace migration caused by agent upgrades
- credential exposure inside untrusted sandboxes

It wins economically only if it also reduces:

- E2B sandbox size
- E2B warm idle time
- duplicated runtime work
- failed upgrade/recovery cost

Measure:

```text
per run:
  Fargate active seconds
  Fargate idle seconds
  E2B active seconds
  E2B warm idle seconds
  tool call count and latency
  Postgres queue wait time
  Postgres run-event write volume
  snapshot creation latency
```

## Main Tradeoffs

Benefits:

- Agent and Claude Code upgrades become normal Fargate deploys.
- E2B templates become smaller and less frequently changed.
- Credentials live in trusted infrastructure, away from arbitrary shell.
- Fargate workers can handle multiple conversations with bounded concurrency.
- Current durable run-event projection model still works.

Costs:

- Tool calls become network calls from Fargate to E2B.
- The E2B SDK/API command surface becomes a sensitive remote execution surface.
- Worker state isolation becomes a first-class concern.
- Scaling requires queue/lease metrics, not just CPU.
- This reshapes the current daemon `/turn` architecture.
- Direct document querying moves document-scope enforcement into worker code.
- Direct OpenRouter use moves provider policy out of the gateway for v1.

## Library Choices

Use:

- Drizzle for schema, migrations, and ordinary database queries.
- `pg` for dedicated `LISTEN/NOTIFY` connections and tightly controlled
  transactional helpers that need driver-level connection control.
- E2B SDK directly for files, commands, pause/resume, snapshots, and sandbox
  lifecycle.
- Claude Agent SDK / Claude Code runtime in `agent-worker`.
- Claude Agent SDK local tool callbacks for v1 tool integration. Do not add an
  MCP server process in v1.

Avoid for v1:

- Redis/BullMQ or other queue infrastructure.
- Temporal, Inngest, Trigger.dev, or workflow engines.
- `p-queue` / `bottleneck` as distributed correctness primitives.
- A second ORM or query builder.
- An in-sandbox executor daemon.

## Prototype Plan

1. Implement the Postgres run foundation:
	 - active-run partial unique index for `{userId, conversationId}`
	 - `runs.cancel_requested_at`
	 - `runs.next_event_seq`
	 - transactionally allocated `run_events.seq`
	 - stale run recovery
	 - `conversation_runtime` for `sandboxId`, latest `snapshotId`, and
	   `workspace_checkpoint_status`
	 - `appendRunEventTx`, `requestRunCancellationTx`, and
	   `transitionRunTerminalTx`
	 - separate `AGENT_DATABASE_URL` and `KB_DATABASE_URL` clients
2. Implement the SSE projector:
	 - durable replay from `run_events`
	 - `LISTEN/NOTIFY` wake-up
	 - 1-2 second polling fallback
	 - read-only run reconnect endpoint
	 - `canceled` terminal frame
3. Validate the E2B command primitives against the real JS SDK:
	 - stdout/stderr streaming through `onStdout` / `onStderr`
	 - command timeout through `timeoutMs`
	 - running-command list/connect/kill behavior
	 - whether timeout and `commands.kill(pid)` terminate descendants
	 - fallback wrapper design if process-tree cleanup is not guaranteed
4. Replace the in-sandbox-agent path with `agent-worker` MCP tool handlers
   backed directly by E2B SDK/API calls.
5. Add a separate Fargate-compatible `agent-worker` process that runs the
   Claude Agent SDK in streaming input mode, supervises the SDK consumer task,
   and uses the executor tools.
6. Implement Postgres-backed atomic `claimNextRunTx` with
   `FOR UPDATE SKIP LOCKED`.
7. Move scoped document querying into the trusted worker through
   `SearchDocuments`.
8. Configure Claude Code / Claude Agent SDK in the worker to use OpenRouter's
   Anthropic Messages-compatible API directly.
9. Add document access audit rows in Postgres.
10. Implement workspace dirty tracking and E2B pause/snapshot checkpoints.
11. Measure a real coding turn:
   - total latency
   - tool call count
   - tool round-trip latency
   - OpenRouter streaming compatibility
   - OpenRouter tool-use compatibility
   - memory per concurrent run
   - command streaming behavior
   - cancellation behavior
   - Postgres queue wait time
   - persistent E2B workspace behavior
   - snapshot creation latency
12. Add scaler only after measured concurrency targets are known.

## Local Testing Plan

Test the design in layers. Do not start with ECS/Fargate; first prove the
worker, queue, tools, OpenRouter compatibility, and E2B SDK behavior from a
local process.

### 1. Unit Tests

No E2B, OpenRouter, or real Postgres.

Cover:

- tool input validation
- path normalization and path traversal rejection
- `Edit` replace-all behavior
- `Grep` input to `rg` argument mapping
- `Glob` input to sandbox command mapping
- document scope guard logic
- run state transitions
- `user.interrupt` request validation and run cancellation state transitions
- snapshot dirty-flag rules
- run-event to SSE frame mapping

### 2. Local Postgres Integration

Use the local compose Postgres or a test Postgres container.

Cover:

- atomic `claimNextRunTx` with `FOR UPDATE SKIP LOCKED`
- two workers cannot claim the same run
- worker heartbeat updates `locked_until`
- stale run recovery marks the run `error`, or `canceled` when cancellation was
  requested
- stale run recovery taints/kills the sandbox or forces restore from the latest
  trusted snapshot
- active-run partial unique index rejects two queued/running/cancel-requested
  runs for one conversation
- `user.interrupt` transitions queued runs directly to `canceled`
- `user.interrupt` transitions running runs to `cancel_requested`
- missed cancellation `NOTIFY` is recovered by heartbeat polling
- event append allocates `seq` through `runs.next_event_seq`
- `run_events(run_id, seq)` ordering
- `LISTEN/NOTIFY` wakes an SSE-style reader
- missed `NOTIFY` is recovered by the 1-2 second polling fallback
- reconnect replay using `Last-Event-ID` through the read-only run events
  endpoint
- `document_access_events` insertion

### 3. Local Tool Handler Tests

Run `agent-worker` tool handlers against a local temporary workspace adapter
instead of E2B. This adapter implements the same internal interface the worker
uses for E2B SDK/API calls, but it reads files and runs commands under a
temporary local directory.

This is not a server inside E2B. It is a local test double for the E2B SDK/API
boundary.

Cover:

- `Read`
- `Write`
- `Edit`
- `Bash`
- `Grep`
- `Glob`
- `SearchDocuments` with fixture-backed document data

For `Bash`, cover:

- normal command
- non-zero exit
- timeout
- cancellation
- rejected background/detached command forms
- process-tree cleanup before command return
- snapshot barrier rejects active or unverified command descendants
- large stdout/stderr truncation

### 4. Worker Orchestration With Fake Model

Use a scripted fake model before OpenRouter.

Example script:

```text
assistant tool call: Write("notes.md", "hello")
assistant tool call: Bash("cat notes.md")
assistant tool call: SearchDocuments("renewal")
assistant final text: "done"
```

Cover:

- worker claims a run
- tool handlers execute
- run events are appended
- `LISTEN/NOTIFY` wakes the streaming reader
- workspace dirty flag is set
- snapshot decision is made
- run is marked `done` or `error`

### 5. Local Chat API SSE E2E

Run locally:

```text
chat-api
agent-worker
Postgres
local workspace adapter
fake model
```

Call:

```text
POST /v1/conversations
POST /v1/conversations/:id/events
GET /v1/conversations/:id/runs/:runId/events
```

Assert SSE frames:

```text
conversation_id
run_id
text_delta
one terminal frame: done | error | canceled
```

Also cover:

- same-conversation busy rejection
- worker crash / stale lock recovery
- client reconnect with `Last-Event-ID` does not create a new run
- cancellation emits `canceled` rather than `done` or `error`

### 6. OpenRouter Smoke Test

Run the real Claude Code / Claude Agent SDK locally inside `agent-worker`,
pointed at OpenRouter:

```text
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY
```

Use the local workspace adapter first.

Verify:

- streaming response
- tool-use turn
- cancellation while a tool call is running
- any Claude Code / SDK token-counting or unsupported Anthropic endpoint calls
- model selection behavior
- understandable provider errors

### 7. E2B SDK Integration Test

Replace the local workspace adapter with real E2B SDK/API calls.

Cover:

- create or connect to the conversation sandbox
- `Read` / `Write` / `Edit` through E2B files APIs or shell-backed fallback
- `Bash` through E2B command APIs
- stdout/stderr streaming
- command timeout and cancellation
- running-command listing and reconnect
- process-tree cleanup, or the fallback wrapper that owns and kills the process
  group
- configured timeout/lifecycle pauses the sandbox after idle, or the prototype
  identifies the explicit pause/checkpoint API that replaces automatic pause
- resume and verify files still exist
- create/update conversation snapshot after dirty turn
- create fresh sandbox from latest snapshot
- user-visible recovery message when snapshot is unavailable

### 8. Full Local Harness

Final local topology before ECS:

```text
chat-api local
agent-worker local
Postgres local
E2B real
OpenRouter real
```

This validates the full runtime except Fargate deployment and autoscaling.

Acceptance criteria:

- a user turn streams tokens through chat-api SSE
- exactly one worker claims the run
- tools execute in E2B, not Fargate shell
- `SearchDocuments` enforces frozen scope without making loaded documents
  durable workspace state
- dirty workspace snapshots after successful turn
- paused sandbox resumes with files intact
- killed sandbox recovers from latest snapshot or returns a clear recovery
  message
- failed run becomes `error`; no automatic retry in v1
- same conversation cannot run concurrently

## Fixed Decisions

- Latency target: p95 first assistant token within 10 seconds for a warm
  `agent-worker` and a reconnectable paused E2B sandbox. Queue wait target: p95
  below 2 seconds while worker capacity is available.
- E2B template dependencies: keep `rg`, shell/coreutils, Git, and language
  runtimes/package managers needed for user code. Do not install Claude Code,
  agent bundles, daemon bundles, provider credentials, or document credentials.
- Model path: direct OpenRouter from `agent-worker`; no gateway in the v1 model
  path.
- Snapshot retention: keep latest and previous successful snapshot references in
  Postgres; clean unreferenced snapshots after 7 days.

## Recommendation

Adopt the split-runtime target if the prototype validates latency, cancellation,
and state isolation. Do not choose it only for raw compute price.

Target production shape:

```text
ECS Fargate service: chat-api
ECS Fargate service: agent-worker
Postgres: conversations, conversation_runtime, runs, run_events
Postgres LISTEN/NOTIFY: live stream wake-up
Model path: direct OpenRouter from agent-worker
E2B: persistent workspace with files and bash
Document access: direct scoped queries from agent-worker
```

Keep the `agent-worker` -> E2B SDK/API surface narrow and treat it as a remote
RCE boundary.
