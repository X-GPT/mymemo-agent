# Split Runtime Fargate/E2B Implementation Plan

This plan turns `docs/split-runtime-fargate-e2b-design.md` into a test-driven
implementation backlog for the first real deployment of the service. There is
no production migration requirement: the current daemon-based prototype does
not need a compatibility rollout or traffic cutover plan.

The deployable-from-day-one constraint means each milestone must fit the
existing `mymemo-service` production deployment path on the `refactor` branch:
Terraform-managed AWS in `infra/terraform`, GitHub Actions release deployment,
RDS Postgres, ECS Fargate services, ALB routing, Secrets Manager, CloudWatch,
and production smoke scripts. Early milestones may return controlled "not
enabled" or queued synthetic responses for users outside the release gate, but
they must boot cleanly and fail closed.

## Assumptions

- The public client contract is the conversation API under `/v1`.
- The first deployed runtime is the split runtime:
  - `mymemo-agent` `chat-api` as an ECS Fargate service for HTTP/SSE and run
    creation.
  - `mymemo-agent` `agent-worker` as an ECS Fargate service for queue polling
    and agent execution.
  - E2B for untrusted filesystem and shell execution.
- The service deploys alongside `mymemo-service`, reusing/extending the
  existing Terraform stack rather than creating a separate deployment system.
- The existing production RDS Postgres is the first queue, run-event store, run
  replay source, and operational ledger. Use separate database roles/schemas for
  writable agent state and read-only KB access.
- The existing sandbox-daemon runtime is prototype code, not a deployed
  production path.
- Production exposure is controlled by a server-side Statsig gate evaluated by
  `chat-api`; infrastructure deployment and user exposure are separate steps.
- E2B SDK pause/snapshot/process-cleanup behavior must be proven by tests or a
  spike before depending on it for user work durability.
- No model-controlled shell command may execute in Fargate.

## Client Contract

The client uses the same API shape regardless of how workers are implemented.
For users outside the Statsig rollout cohort, new-work endpoints return `403`
and the product surface should stay hidden.

1. Create a conversation:

```http
POST /v1/conversations
X-Member-Code: member-1
X-Partner-Code: partner-1
Content-Type: application/json

{ "collectionId": "optional", "summaryId": "optional" }
```

Response:

```json
{ "conversationId": "...", "scope": "general" }
```

2. Send a user message and read the SSE stream:

```http
POST /v1/conversations/{conversationId}/events
X-Member-Code: member-1
X-Partner-Code: partner-1
Content-Type: application/json

{ "type": "user.message", "text": "..." }
```

SSE frames:

```text
conversation_id
run_id
sandbox_id
agent_session_id
text_delta
done | canceled | error
```

3. Reconnect to an existing run without creating another backend attempt:

```http
GET /v1/conversations/{conversationId}/runs/{runId}/events
Last-Event-ID: <last-seen-seq>
```

4. Cancel an active run:

```http
POST /v1/conversations/{conversationId}/events
Content-Type: application/json

{ "type": "user.interrupt", "runId": "..." }
```

`user.interrupt` returns JSON immediately. The terminal `canceled` frame is
delivered through the original run stream or the reconnect endpoint.

## Deployment Shape

The first deployable environment contains:

- Extensions to the existing `mymemo-service/refactor` Terraform stack:
  - ECR repositories for `mymemo-agent-chat-api` and `mymemo-agent-worker`
  - ECS Fargate service for `mymemo-agent-chat-api`
  - ECS Fargate service for `mymemo-agent-worker`
  - ALB listener rule/path routing for the agent API, or an internal target if
    `mymemo-service` proxies it first
  - CloudWatch log groups, alarms, and dashboards for both agent services
  - IAM task-role permissions for E2B access, Secrets Manager reads, logs, and
    the existing S3/RDS resources only where needed
  - Secrets Manager entries for agent-only secrets
  - scheduled recovery/cleanup/scaler jobs if they are separate from the worker
- Postgres migration task integrated with the existing migration/deploy flow.
- E2B template build/verification step containing only stable executor
  dependencies.
- Postgres roles:
  - writable agent role/schema for `chat-api` and `agent-worker` run state
  - read-only KB role/schema for `agent-worker` document search
- secrets:
  - `AGENT_DATABASE_URL`
  - `KB_DATABASE_URL`
  - `OPENROUTER_API_KEY`
  - `E2B_API_KEY`
  - `STATSIG_SERVER_SECRET`
- health checks:
  - `mymemo-agent-chat-api` route health
  - `mymemo-agent-worker` DB connectivity and queue-loop health

Deployment order:

1. Extend `mymemo-service/infra/terraform` on `refactor` with the agent ECR
   repositories, ECS services, task definitions, secrets, log groups, alarms,
   ALB routing, and migration task.
2. Extend `.github/workflows/release-deploy.yml` or add a sibling release job
   so the existing release pipeline builds and pushes the agent images, prepares
   tfvars, runs Terraform plan/apply, rolls ECS services, and runs smoke tests.
3. Build or verify the E2B executor template.
4. Run agent DB migrations as part of the existing one-shot migration stage,
   before the agent services accept traffic.
5. Deploy `mymemo-agent-chat-api` with the Statsig gate defaulting closed for
   normal users.
6. Deploy `mymemo-agent-worker` with `desiredCount >= 1`.
7. Run the existing `mymemo-service` smoke suite plus an agent synthetic
   conversation smoke test through the production ALB using an allowlisted
   Statsig user.
8. Open the Statsig gate to the intended cohort.

Manual console changes are not the planned deployment mechanism. They are
acceptable only for temporary prototype spikes, and any retained setting must be
backfilled into `mymemo-service/infra/terraform` before production exposure.

Rollback for early deployments is service-level plus exposure-level:

- roll back the ECS service image
- close the Statsig gate
- keep DB migrations additive until the first public launch
- keep E2B sandboxes and snapshots until cleanup verifies they are unreferenced

## Statsig Exposure Gate

Yes: use Statsig to gate who can see the production-deployed service. The gate
does not replace auth, ownership checks, DB invariants, or worker fencing. It
only controls whether a valid internal caller is allowed to create and run
agent conversations.

Initial gate:

```text
mymemo_agent_split_runtime_enabled
```

Evaluation point:

- evaluate in `chat-api` after trusted identity headers are parsed
- use stable user attributes such as `memberCode`, `partnerCode`, `teamCode`,
  and environment
- do not evaluate in the worker as the primary gate; workers process only runs
  already admitted by `chat-api`

Fail-closed behavior:

- if Statsig is unavailable, uninitialized, or returns an error, reject new
  conversation creation and new `user.message` events unless a local
  break-glass env override is explicitly enabled for operators
- existing active runs may continue so the system does not strand work already
  admitted
- reconnect and cancel endpoints remain available for existing runs owned by
  the user, even if the gate later closes

Client-visible behavior for gated-off users:

- `POST /v1/conversations` returns `403 { "error": "Agent is not enabled" }`
  when the product should be hidden entirely
- if conversations may be created by another surface, then
  `POST /v1/conversations/:conversationId/events` returns the same `403` for
  `user.message`
- `GET /runs/:runId/events` and `user.interrupt` keep ownership checks and do
  not create new work

Tests first:

- allowed Statsig user can create a conversation and queue a run
- denied Statsig user cannot create new work
- Statsig error fails closed for new work
- reconnect and interrupt for existing owned runs still work when the gate is
  closed
- gate evaluation uses identity headers, not request body fields
- no Statsig secret is sent to E2B or logged

## State Tables

### `conversation_runtime`

One row per `{userId, conversationId}` for persistent E2B workspace metadata:

- current `sandboxId`
- latest and previous snapshot ids
- checkpoint status
- taint/dirty state

This table does not grant active execution ownership. Active ownership lives in
`runs`.

### `runs`

The queue and execution ownership table:

- `queued | running | cancel_requested | done | error | canceled`
- `lockedBy`
- `lockedUntil`
- `heartbeatAt`
- `cancelRequestedAt`
- `nextEventSeq`

The database must enforce one active run per `{userId, conversationId}`.

### `run_events`

The durable, ordered event stream for audit, SSE projection, and reconnect.
This is the source of truth for client replay.

### `document_access_events`

Audit ledger for trusted document access performed by `agent-worker`.

This is separate from `run_events` because it has a different job:

- security/compliance can answer "which scoped documents did this run search or
  fetch?"
- rows can include document ids, scope filters, result counts, and policy
  decisions without exposing that detail to the client SSE stream
- retention and access controls can differ from chat-visible run events

If product policy later decides document access does not need separate
retention/querying, this can be folded into structured `run_events`. The first
implementation keeps it separate because document access is a trust-boundary
audit concern, not only a UI event.

### `orphan_sandboxes`

Recovery ledger for E2B sandboxes that were created but could not be safely
stored as the current `conversation_runtime.sandboxId`.

Example:

1. worker creates a replacement E2B sandbox
2. worker loses run ownership before the fenced DB update succeeds
3. worker tries to kill the new sandbox
4. if kill fails or cannot be confirmed, the sandbox id is recorded here

The cleanup job later verifies the sandbox is not referenced by
`conversation_runtime` and kills it. Without this table, failed side effects can
leave paid, persistent E2B resources outside database ownership.

## Why Cleanup Exists

Cleanup is not migration cleanup. It is runtime hygiene for external resources
that Postgres cannot delete transactionally:

- E2B sandboxes created before a failed fenced write
- stale sandboxes after failed recovery
- unreferenced snapshots after retention
- runtime rows for deleted conversations or users

The cleanup rule is conservative: never kill a sandbox or snapshot that is still
referenced by `conversation_runtime`.

## TDD Workflow

For each task:

1. Write or update the narrowest failing test first.
2. Implement the minimum production code to pass it.
3. Add one integration test at the boundary if the task changes a database
   transaction, route contract, worker loop, deployment health check, or E2B
   tool behavior.
4. Run the smallest relevant test target first, then the workspace test command
   before marking the task complete.

Preferred checks:

```bash
bun test
bun run test
```

Use PGlite or local test doubles for queue/state tests. Use live E2B tests only
for the SDK semantics gates called out below.

## Milestone 0: Deployable Skeleton

Goal: create a bootable deployment skeleton before implementing real agent
execution.

### Task 0.1: Define First-Deploy Config

Add typed env validation for:

- `AGENT_DATABASE_URL`
- `KB_DATABASE_URL`
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL`
- `OPENROUTER_DEFAULT_MODEL`
- `E2B_API_KEY`
- `STATSIG_SERVER_SECRET`
- worker concurrency and heartbeat intervals

Tests first:

- `chat-api` refuses to boot without the writable agent DB URL.
- `agent-worker` refuses to boot without worker-only secrets.
- secrets required by the worker are not required by `chat-api`.
- Statsig configuration is required in production but can be replaced with a
  fake gate in tests.
- no provider or KB secret is included in E2B sandbox env construction.

Verify:

- both apps have deterministic health behavior when configured correctly.

### Task 0.2: Add Statsig Gate Seam

Add a small `ExposureGate` interface in `chat-api`:

```ts
interface ExposureGate {
	isAgentEnabled(identity: InternalIdentity): Promise<boolean>;
}
```

Production implementation uses Statsig. Tests use a fake implementation.

Tests first:

- allowed identity can create a conversation.
- denied identity receives `403` before any conversation/run write.
- Statsig failures fail closed for new work.
- reconnect and interrupt for existing runs do not depend on the new-work gate.
- request body identity fields cannot influence the gate.

Verify:

- gate decisions are logged without leaking the Statsig secret.

### Task 0.3: Create `apps/agent-worker`

Add a Bun workspace app with:

- env validation
- structured logger
- worker id generation
- configurable concurrency
- graceful shutdown
- health endpoint or health log heartbeat
- Dockerfile

Tests first:

- env validation rejects missing worker DB settings.
- default concurrency is conservative.
- shutdown stops new claims and waits for active tasks within a timeout.

Verify:

- workspace test runner includes `apps/agent-worker`.
- worker image builds locally.

### Task 0.4: Extend `mymemo-service` Terraform Deployment

Extend `/Users/chengchao/code/mymemo/mymemo-service/infra/terraform` rather
than creating a parallel AWS deployment. Expected touch points:

- `ecr.tf` for agent image repositories
- `ecs.tf` for `mymemo-agent-chat-api` and `mymemo-agent-worker` task
  definitions/services, or dedicated `ecs_agent*.tf` files if that keeps the
  existing file readable
- `alb.tf` for agent path routing or service-to-service routing support
- `iam.tf` for task-role access to E2B-related secrets and existing AWS
  resources
- `secrets.tf` for `STATSIG_SERVER_SECRET`, `OPENROUTER_API_KEY`,
  `E2B_API_KEY`, and agent DB credentials
- `cloudwatch.tf` for agent log groups and alarms
- `ecs_migrations.tf` for agent DB migrations
- `variables.tf` / `outputs.tf` for image tags, desired counts, service URLs,
  and smoke-test inputs

Extend the existing deployment pipeline:

- `.github/workflows/release-deploy.yml` builds and pushes both agent images
  alongside the existing backend image
- `scripts/deploy/build_and_push_backend_image.sh` is copied or generalized for
  agent images
- `scripts/deploy/ci_prepare_tfvars.sh` writes agent image tags and desired
  counts into the production tfvars material
- `scripts/deploy/terraform_prod_in_place_plan.sh` and
  `scripts/deploy/terraform_prod_in_place_apply.sh` remain the guarded
  Terraform entrypoints
- `scripts/deploy/roll_ecs_services.sh` rolls the agent services too
- `scripts/deploy/prod_smoke.sh` adds an allowlisted Statsig agent smoke test

Tests first:

- configuration examples are parseable by the app env loaders.
- smoke-test code can run against an in-process server or configured base URL.
- Terraform variable examples include every required secret reference and no
  literal secret values.
- `terraform -chdir=infra/terraform fmt -check` and `terraform validate` pass
  from the `mymemo-service` repo.

Verify:

- a production deploy through the existing `release` branch pipeline can update
  the existing MyMemo stack and keep the Statsig gate closed by default.

## Milestone 1: Postgres Run Store

Goal: create the durable run queue and event log.

### Task 1.1: Add Schema and Migration

Add:

- `conversation_runtime`
- `runs`
- `run_events`
- `document_access_events`
- `orphan_sandboxes`

Key DB invariants:

- partial unique index on one active run per conversation
- unique `(run_id, seq)` for run events
- check constraints for run statuses and checkpoint statuses
- foreign-key or ownership-equivalent constraints where practical
- indexes for queue claim, SSE replay, stale-run recovery, and cleanup scans

Tests first:

- migration applies to a fresh test database.
- valid rows insert successfully.
- invalid statuses fail.
- two active runs for the same `{userId, conversationId}` fail at the DB layer.
- terminal runs do not block later runs for the same conversation.

Verify:

- `bun run db:generate` creates the migration from schema changes.
- DB tests pass against the generated schema.

### Task 1.2: Implement Run Store Transactions

Implement narrow helpers:

- `createQueuedRunTx`
- `claimNextRunTx`
- `appendRunEventTx`
- `transitionRunTerminalTx`
- `requestRunCancellationTx`
- `heartbeatRunTx`
- `markStaleRunsTx`

Tests first:

- `claimNextRunTx` claims with `FOR UPDATE SKIP LOCKED` semantics.
- app-side select/update races are not possible through the public helper.
- event sequence allocation is monotonic and database-owned.
- model/content appends require `status = running` and matching `locked_by`.
- cancellation audit appends allow `running | cancel_requested`.
- stale worker appends are rejected after `locked_until`.
- terminal transition appends exactly one terminal event.

Verify:

- run-store tests cover both successful transitions and failed ownership fences.

## Milestone 2: Conversation API and SSE

Goal: make the client contract usable before real model execution.

### Task 2.1: Queue Runs from `user.message`

`POST /v1/conversations/:conversationId/events` should:

1. validate identity and conversation ownership before stream open
2. insert a queued run transactionally
3. append `run_started`
4. open the durable SSE projector

Tests first:

- successful message creates one queued run.
- active-run unique index returns busy/backpressure before SSE starts.
- frozen conversation scope is not accepted from the turn body.
- missing or foreign conversation returns `404`.

Verify:

- with no worker running, the request can stream queued/start events and remain
  replayable.

### Task 2.2: Add Run Event Projector

Create a projector that:

- reads existing events by `seq > lastSeq`
- maps internal events to client SSE frames
- waits on `LISTEN/NOTIFY` or a short polling timeout
- closes on terminal events

Tests first:

- replay from `seq = 0` emits `conversation_id`, `run_id`, text deltas, and
  terminal frames in order.
- replay from `Last-Event-ID` skips already-seen events.
- missed notifications do not lose events.
- `run_canceled` maps to `canceled`, not `error`.

Verify:

- projector tests use a fake notifier and deterministic event rows.

### Task 2.3: Add Read-Only Reconnect Endpoint

Add:

```text
GET /v1/conversations/:conversationId/runs/:runId/events
```

Tests first:

- validates identity headers.
- returns `404` for foreign or missing conversations/runs.
- does not create a new run.
- honors `Last-Event-ID`.
- streams terminal historical runs and closes.

Verify:

- route-level tests use the in-process Hono app.

### Task 2.4: Add `user.interrupt`

Extend the event body:

```ts
{ type: "user.interrupt"; runId: string }
```

Tests first:

- queued run transitions to `canceled` and appends `run_canceled`.
- running run transitions to `cancel_requested` and leaves `locked_by` intact.
- terminal run returns `409` with current status.
- foreign/missing run returns `404`.
- interrupt returns JSON and never opens SSE.

Verify:

- route tests cover both event union branches.

## Milestone 3: Agent Worker Queue Loop

Goal: deploy a warm worker service that can claim, heartbeat, and terminalize
synthetic runs.

### Task 3.1: Implement Poll/Claim/Heartbeat Loop

Implement the worker control loop using run-store helpers.

Tests first:

- worker respects hard concurrency.
- two workers do not claim the same run.
- heartbeat extends only owned runs.
- failed synthetic processing transitions to `error`.
- cancellation requested during synthetic processing transitions to `canceled`.

Verify:

- use fake timers and PGlite where possible.
- synthetic end-to-end smoke test creates a conversation, queues a run, worker
  claims it, appends a text event, and completes it.

### Task 3.2: Add Stale Run Recovery

Add a recovery loop that runs at least every 15 seconds.

Tests first:

- stale running run transitions to `error`.
- stale cancel-requested run transitions to `canceled`.
- stale worker cannot append after recovery terminalizes the run.

Verify:

- recovery and worker loops cannot produce double-terminal events.

## Milestone 4: E2B Executor Semantics

Goal: prove and wrap the E2B substrate before wiring it to the model.

### Task 4.1: Prototype E2B Semantics Gate

Write explicit live tests or a documented spike for:

- pause-on-timeout preserves files
- paused sandbox can reconnect or resume
- active timeout can be extended
- snapshot creation returns a reusable checkpoint id
- fresh sandbox can restore from checkpoint
- command timeout/cancel cleanup handles descendants or needs a wrapper

Acceptance:

- if E2B SDK behavior is insufficient, create the sandbox-side command wrapper
  before enabling Bash.

### Task 4.2: Add Conversation Runtime Store

Implement fenced helpers for:

- load runtime row
- create runtime row
- update `sandboxId`
- update latest/previous snapshot ids
- mark checkpoint status
- record orphan sandbox

Tests first:

- metadata updates fail after run ownership is lost.
- replacement sandbox is killed or recorded as orphan if fenced update fails.
- checkpoint failure leaves latest snapshot unchanged and marks
  `dirty_uncheckpointed`.

Verify:

- all runtime mutations go through ownership-fenced helpers.

## Milestone 5: Executor Tools

Goal: implement the model-facing tool substrate with strict path, timeout, and
output boundaries.

### Task 5.1: Implement Path-Safe File Tools

Implement internal handlers for:

- `Read`
- `Write`
- `Edit`
- `Grep`
- `Glob`

Tests first:

- path traversal is rejected before any E2B call.
- absolute paths outside the workspace are rejected.
- read byte/line caps are enforced.
- write/edit mark workspace dirty only after success.
- grep/glob return deterministic bounded results.
- E2B errors are converted into bounded tool errors.

Verify:

- unit tests use an E2B client fake.
- one integration test covers the real command-backed grep/glob path.

### Task 5.2: Implement Foreground-Only Bash

Implement `Bash(command, cwd?, timeoutMs?)` with:

- system max timeout
- stdout/stderr streaming caps
- command audit events
- command tree cleanup
- cancellation hook
- dirty workspace tracking

Tests first:

- timeout is clamped to the system maximum.
- output is bounded.
- obvious detached forms are rejected with user-facing feedback.
- cancellation calls the active command cancel path.
- cleanup failure marks the sandbox tainted and prevents `done`.
- every command is bound to `{userId, conversationId, runId, sandboxId}`.

Verify:

- live E2B test proves descendant cleanup or validates the wrapper.

### Task 5.3: Add Snapshot Barrier

Before terminal success:

1. verify no managed command is running
2. snapshot if workspace is dirty
3. persist snapshot metadata with ownership fence
4. append `run_completed`

Tests first:

- clean workspace can complete without snapshot.
- dirty workspace snapshots once per successful turn.
- snapshot failure transitions to `error`.
- ownership loss during snapshot prevents `done`.
- cancellation wins over success before terminal transition.

Verify:

- run terminal tests assert final event ordering.

## Milestone 6: Document Search in Worker

Goal: move document search into trusted Fargate worker code.

### Task 6.1: Add Scoped Document Query Client

Use separate writable agent DB and read-only KB credentials:

```text
AGENT_DATABASE_URL
KB_DATABASE_URL
```

Tests first:

- worker refuses to start document search without KB credentials.
- scope guard rejects searches outside the frozen conversation scope.
- document access audit rows are written.
- KB errors return bounded tool errors without leaking credentials or SQL.

Verify:

- document credentials are only present in the worker task.

### Task 6.2: Add `SearchDocuments` Tool

Tests first:

- general, collection, and document scopes produce the expected query filters.
- `maxResults` is capped by worker config.
- empty results are stable and model-readable.
- document access events include run/conversation/user identifiers.

Verify:

- no document credential is sent to E2B.

## Milestone 7: Claude Agent SDK Integration

Goal: run the model loop in Fargate with tool calls backed by E2B.

### Task 7.1: Add Model Client Configuration

Configure OpenRouter/Anthropic-compatible model traffic in the worker.

Tests first:

- missing OpenRouter settings fail worker startup.
- model headers are injected only in the trusted worker.
- E2B tool calls receive no provider key.

Verify:

- no provider key appears in sandbox env construction tests.

### Task 7.2: Consume SDK Stream Under Supervision

Implement active run state:

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

Tests first:

- SDK text messages append model/content events only while status is `running`.
- tool calls invoke the executor with the correct run binding.
- SDK error transitions to `error`.
- after `cancel_requested`, normal content is ignored and terminal state becomes
  `canceled`.
- shutdown interrupts active queries and cancels active E2B commands.

Verify:

- use a fake SDK stream for deterministic unit tests.

## Milestone 8: Operations and Scaling

Goal: keep the first deployed service safe under failure and load.

### Task 8.1: Orphan and Snapshot Cleanup

Tests first:

- orphan sandbox cleanup never kills the currently referenced sandbox.
- cleanup retries failures.
- old unreferenced snapshots become eligible after retention.
- conversation deletion cleanup clears runtime sandbox pointers only after kill
  succeeds or records retry state.

Verify:

- cleanup failures do not block unrelated user runs.

### Task 8.2: Queue Metrics and Scaler

Implement a small scaler query/module before adding AWS control-plane calls.

Tests first:

- desired task count uses
  `ceil((queuedRuns + runningRuns) / targetConcurrentRunsPerTask)`.
- result is clamped by min/max.
- scale-in cooldown is honored.

Verify:

- AWS ECS `UpdateService` integration is isolated behind a tiny adapter and can
  be tested with a fake.

### Task 8.3: First Production Smoke Suite

Run against the deployed environment:

- create conversation
- stream a successful message
- reconnect with `Last-Event-ID`
- cancel a running turn
- run a bounded shell command
- create a file and verify it survives sandbox pause/reconnect
- trigger worker restart during an active run and verify recovery

Exit criteria:

- split runtime serves normal traffic.
- stale-run recovery is operating.
- run-event replay is the only SSE source.
- no provider, KB, or broad document credential is present in E2B.
- cleanup jobs are enabled and conservative.
