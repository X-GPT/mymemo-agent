# Split Runtime Fargate/E2B Implementation Plan

This plan turns `docs/split-runtime-fargate-e2b-design.md` into a test-driven
implementation backlog for the first real deployment of the service. There is
no production migration requirement: the current daemon-based prototype does
not need a compatibility rollout or traffic cutover plan.

The deployable-from-day-one constraint means each milestone must fit the
existing MyMemo production AWS environment while keeping agent deployment code
in this repo: Terraform-managed AWS under `mymemo-agent/infra/terraform`, GitHub
Actions release deployment, RDS Postgres, ECS Fargate services, ALB routing,
Secrets Manager, CloudWatch, and production smoke scripts. The agent Terraform
must consume the same VPC/network context as `mymemo-service` through explicit
inputs or reviewed outputs; it must not create a parallel VPC. Early milestones
may return controlled "not enabled" or queued synthetic responses for users
outside the release gate, but they must boot cleanly and fail closed.

## Assumptions

- The public client contract is the conversation API under `/v1`.
- The first deployed runtime is the split runtime:
  - `mymemo-agent` `chat-api` as an ECS Fargate service for HTTP/SSE and run
    creation.
  - `mymemo-agent` `agent-worker` as an ECS Fargate service for queue polling
    and agent execution.
  - E2B for untrusted filesystem and shell execution.
- The service deploys alongside `mymemo-service`, reusing the existing
  `mymemo-service` VPC/network while owning agent Terraform and release wiring
  in `mymemo-agent`.
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
text_delta
done | canceled | error
```

The prototype-era `sandbox_id` and `agent_session_id` frames are not part of
the split-runtime contract: both are internal runtime identifiers (the design
doc classifies the agent session id as internal/runtime-facing), and in the
split runtime they only exist after a worker claims the run, so they could
never be reliable early frames. Operators find them in `run_events`, not in
the client stream.

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

- Agent-owned Terraform in `mymemo-agent/infra/terraform`, consuming the existing
  `mymemo-service` VPC/subnet/security-group/ALB/cluster identifiers as explicit
  deployment inputs:
  - ECR repositories for `mymemo-agent-chat-api` and `mymemo-agent-worker`
  - ECS Fargate service for `mymemo-agent-chat-api`
  - ECS Fargate service for `mymemo-agent-worker`
  - ALB listener rule/path routing for the agent API, or an internal target if
    `mymemo-service` proxies it first
  - CloudWatch log groups, alarms, and dashboards for both agent services
  - IAM task-role permissions for E2B access, Secrets Manager reads, logs, and
    the existing S3/RDS resources only where needed
  - Secrets Manager entries for agent-only secrets
  - no separate scheduled recovery/cleanup jobs: those loops are
    worker-embedded (cleanup single-flighted via a Postgres advisory lock);
    the Milestone 8 scaler is the only separate scheduled job
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

1. Add `mymemo-agent/infra/terraform` with the agent ECR repositories, ECS
   services, task definitions, secrets, log groups, alarms, ALB routing, and
   migration task.
2. Add or extend `.github/workflows/release-deploy.yml` in `mymemo-agent` so the
   release pipeline builds and pushes the agent images, prepares tfvars with
   reviewed `mymemo-service` network inputs, runs Terraform plan/apply, rolls ECS
   services, and runs smoke tests.
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
acceptable only for temporary prototype spikes, and any retained agent setting
must be backfilled into `mymemo-agent/infra/terraform` before production
exposure.

Rollback for early deployments is service-level plus exposure-level:

- roll back the ECS service image
- close the Statsig gate
- keep DB migrations additive until the first public launch
- keep E2B sandboxes and snapshots until cleanup verifies they are unreferenced

## Prototype Path Decommissioning

The daemon-based prototype path is replaced by a hard swap, not flag-switched
coexistence: the two paths enforce "one active turn per conversation" with
different authorities (`sandbox_leases` CAS vs the `runs` partial unique
index), so a deployment where both are reachable has no single authority for
that invariant (ADR-0002).

Schedule:

- Task 2.1 swaps the `user.message` handler from `runSandboxChat` to
  queued-run insertion in one PR. chat-api's `sandbox-orchestration` and
  `sandbox-agent` features, llm-token minting, the in-memory `run-state`
  lifecycle module, and the WorkspaceStore-backed NDJSON run-event log are
  deleted with the swap (the Postgres `runs`/`run_events` model replaces
  them).
- Milestone 3's synthetic worker restores a working end-to-end SSE demo; the
  compose/e2e harness is rewritten against split-runtime semantics then.
- `apps/gateway`, `apps/sandbox-daemon`, `apps/mymemo-docs`,
  `packages/llm-token`, and the compose `gateway`/`sandbox` services are
  deleted when Milestone 7 passes the full local harness.
- `sandbox_leases` is dropped in the same migration that creates
  `conversation_runtime` (Task 4.2).

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

### `agent_sessions`

Claude SDK session transcript mirror — the `SessionStore` adapter's backing
table (one jsonb row per transcript entry, keyed by
`projectKey/sessionId/subpath`, insertion-ordered). Worker-only; created at
Milestone 7 with the continuity task. The per-conversation resume pointer
lives in `conversation_runtime.agent_session_id`, not here.

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

### Task 0.4: Add `mymemo-agent` Terraform Deployment Using the `mymemo-service` VPC

Add Terraform and release wiring in this repo. The agent Terraform must live
under `mymemo-agent/infra/terraform`, consume the existing `mymemo-service`
VPC/network/cluster identifiers through explicit inputs, and avoid creating a
parallel VPC or separate AWS network stack. Expected touch points:

- `infra/terraform/ecr.tf` for agent image repositories
- `infra/terraform/ecs.tf` for `mymemo-agent-chat-api` and
  `mymemo-agent-worker` task definitions/services
- `infra/terraform/alb.tf` for agent path routing on the existing MyMemo ALB or
  service-to-service routing support
- `infra/terraform/network.tf` for agent-owned service security groups inside
  the existing VPC, not new VPC/subnet resources
- `infra/terraform/iam.tf` for task-role access to E2B-related secrets and
  existing AWS resources
- `infra/terraform/variables.tf` / `outputs.tf` for shared-network inputs, image
  tags, desired counts, service URLs, and smoke-test inputs
- `infra/terraform/cloudwatch.tf` for agent log groups and alarms
- agent DB migration task definition
- example tfvars documenting the deployment contract with `mymemo-service`
  networking

Add the agent deployment pipeline:

- `.github/workflows/release-deploy.yml` builds and pushes both agent images
- `scripts/deploy/build_and_push_agent_image.sh` builds and pushes agent images
- `mymemo-service` remote state is the reviewed shared-infra contract; agent
  deploy config does not duplicate VPC/subnet/cluster/listener/security-group
  IDs
- `infra/terraform/prod.tfvars` is the reviewed Terraform contract for
  agent-owned non-secret infrastructure/runtime inputs; Terraform resolves
  conventional Secrets Manager names to ARNs internally
- `infra/deploy/prod.env` is limited to CI/deploy shell settings such as AWS
  account and smoke-test inputs
- `infra/deploy/prod.secrets.env` is git-ignored local bootstrap input for
  literal secret values, and `scripts/deploy/create_agent_secrets.sh` creates or
  updates the conventional AWS Secrets Manager entries
- `scripts/deploy/run_agent_migration.sh` runs the agent DB migration task after
  Terraform apply and before ECS service rollout
- `scripts/deploy/ci_prepare_tfvars.sh` reads CI-provided environment variables
  and writes only the immutable agent image URIs into generated Terraform tfvars
- `scripts/deploy/terraform_prod_in_place_plan.sh` and
  `scripts/deploy/terraform_prod_in_place_apply.sh` are guarded Terraform
  entrypoints from this repo
- `scripts/deploy/roll_ecs_services.sh` rolls the agent services too
- `scripts/deploy/prod_smoke.sh` adds an allowlisted Statsig agent smoke test

Tests first:

- configuration examples are parseable by the app env loaders.
- smoke-test code can run against an in-process server or configured base URL.
- Terraform variable examples include every required shared-network input and
  the conventional secret-name contract with no literal secret values.
- checked-in `prod.tfvars` contains agent-owned non-secret Terraform config,
  and checked-in `prod.env` contains CI/smoke settings only.
- git-ignored secret bootstrap files are ignored, and checked-in examples never
  contain literal secret values.
- Terraform does not define a new VPC for the agent services.
- `terraform -chdir=infra/terraform fmt -check` and `terraform validate` pass
  from the `mymemo-agent` repo.

Verify:

- a production deploy through the agent release path can update the agent
  services in the existing MyMemo VPC and keep the Statsig gate closed by
  default.
- the deployment contract with `mymemo-service` networking is documented enough
  that VPC/subnet/security-group changes are explicit and reviewable.

## Milestone 1: Postgres Run Store

Goal: create the durable run queue and event log.

### Task 1.1: Add Schema and Migration

Add:

- `runs` (landed via MYM-49)
- `run_events` (landed via MYM-49)
- `document_access_events`

`conversation_runtime` and `orphan_sandboxes` are deliberately not part of
this task: their shape is an output of the E2B semantics spike (Task 4.1,
hoisted to run in parallel with Milestones 1-3), so they are created in
Task 4.2 after the spike passes.

Key DB invariants:

- partial unique index on one active run per conversation
- unique `(run_id, seq)` for run events
- check constraints for run statuses and checkpoint statuses
- foreign-key or ownership-equivalent constraints where practical
- indexes for queue claim, SSE replay, stale-run recovery, and cleanup scans

`runs` carries no fencing token: a v1 run is claimed exactly once (failed runs
do not requeue; stale runs are terminalized, never reclaimed), so
`locked_by` + `locked_until` is the complete ownership fence. Remove the
speculative `fencing_token` column from the landed MYM-49 schema. A token
returns only with a future requeue feature that makes multiple holds per run
possible — in the same PR as the requeue logic.

`run_events` carries no `visibility` column: the projector's event-type→frame
mapping is the single authority for client exposure, and unmapped types are
skipped (fail-closed — a new internal event type cannot leak to clients
without an explicit frame mapping). Remove the landed MYM-49 `visibility`
column together with `fencing_token`. The design doc's append classes remain
the write-side rule; they govern who may write, not what the client sees.

Because nothing is in production, do both removals by regenerating the
migration history as a clean baseline (erase `drizzle/`, regenerate one
0000 migration) instead of stacking drop-migrations. Any previously migrated
environment DB must be reset to the new baseline.

This task also carries the driver decision: swap chat-api's Drizzle driver
from `drizzle-orm/bun-sql` to `drizzle-orm/node-postgres` (`pg`) in
`src/db/client.ts` and `src/db/migrate.ts`, adding the `pg` dependency — one
driver everywhere, since `pg` must exist anyway for the `LISTEN` connections
Bun.sql does not implement. Caveat found while validating: the resolved URL
appends `sslmode=require`, which `pg` treats as verified TLS (it checks the
server cert against the trust store) while Bun.sql is laxer — verify the
first RDS connection after the swap, and if verification fails supply the
RDS CA bundle or switch the URL policy to `sslmode=no-verify`.

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

This task is hoisted: it runs now, in parallel with Milestones 1-3, as a
standalone script against real E2B. It depends on nothing from earlier
milestones, it is the highest-risk unknown in the design, and
`conversation_runtime`'s schema is its output. Validate against the pinned
SDK (`e2b ^2.14.0`), not the design doc's older v2.6.0 citation, and update
the design doc with the findings.

Write explicit live tests or a documented spike for:

- pause-on-timeout preserves files
- paused sandbox can reconnect or resume
- active timeout can be extended
- snapshot creation returns a reusable checkpoint id
- fresh sandbox can restore from checkpoint
- command timeout/cancel cleanup handles descendants or needs a wrapper
- the cost/storage model: whether a paused sandbox is a distinct billed
  object from a snapshot and what each costs at rest

Acceptance:

- if E2B SDK behavior is insufficient, create the sandbox-side command wrapper
  before enabling Bash.
- the paused-sandbox retention policy (live-forever vs bounded idle lifetime
  with snapshot restore) is decided from the measured cost model.

### Task 4.2: Add Conversation Runtime Store

Create the `conversation_runtime` and `orphan_sandboxes` tables here (moved
out of Task 1.1; their shape is confirmed by the Task 4.1 spike), and drop
`sandbox_leases` in the same migration (ADR-0002).

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
4. append `run_done`

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
- results carry `passageId` and `documentId` so hits stay citable and
  loadable.
- empty results are stable and model-readable.
- document access events include run/conversation/user identifiers.

Verify:

- no document credential is sent to E2B.

### Task 6.3: Add `LoadDocuments` Tool

Materializes documents-as-files (ADR-0004): the worker copies scope-checked
content into the conversation's reserved docs-cache directory in the sandbox
and returns metadata only.

Tests first:

- the tool result contains `{documentId, title, path, truncated}` and never
  document content; no document body appears in run events.
- content is written under the reserved docs-cache directory; paths are
  workspace-rooted.
- out-of-scope, unknown, and non-active document ids produce bounded,
  model-readable errors without leaking document existence across scopes.
- per-document and per-call byte caps are enforced; truncation is marked in
  the written file and the result.
- re-loading an already-cached id overwrites the file (refresh-on-load).
- loading does not mark the workspace dirty.
- full-document loads are audited in `document_access_events`.

Verify:

- no document credential is sent to E2B; only file content lands on disk.

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

### Task 7.3: Conversation Continuity via Postgres SessionStore

Add the `agent_sessions` table, the `SessionStore` adapter (start from the
SDK's Postgres reference implementation), and `agent_session_id` on
`conversation_runtime` (ADR-0005).

Tests first:

- the adapter passes the SDK's SessionStore conformance suite.
- `append` deduplicates by `entry.uuid` (retried batches re-deliver).
- a run with no resume pointer starts a fresh session; a run with a pointer
  resumes it through the store.
- the pointer advances only in the terminal-success transition, under the
  ownership fence; a stale worker cannot move it.
- a run that observed `mirror_error` does not advance the pointer and still
  terminates `done`.
- the query working directory is deterministic per conversation, so
  `projectKey` is stable across workers and turns.
- conversation deletion deletes the conversation's transcripts.

Verify:

- live check: resume on a second worker process reproduces prior-turn
  context; record whether a resumed query keeps or renews its session id
  (the worker always stores the id from the result message).

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
- search a scoped document, load it into the docs cache, and read it back
  through file tools
- create a file and verify it survives sandbox pause/reconnect
- trigger worker restart during an active run and verify recovery

Exit criteria:

- split runtime serves normal traffic.
- stale-run recovery is operating.
- run-event replay is the only SSE source.
- no provider, KB, or broad document credential is present in E2B.
- cleanup jobs are enabled and conservative.

## Milestone 9: Wire the Real SDK Run Loop

Goal: replace the synthetic processor with a real Claude Agent SDK query per
run, backed by a provisioned E2B sandbox, and remove the snapshot layer
(ADR-0006, ADR-0007). Tasks are ordered; Task 9.1 gates the rest.

### Task 9.1: SDK Runtime Spike (gate) — DONE 2026-07-09

Throwaway `spikes/sdk-runtime/` proof runner (same lifecycle as the Task 4.1
E2B spike: findings → this plan + ADR-0006, then delete the directory). Ran
against real OpenRouter (`anthropic/claude-sonnet-4`) and the built
linux/amd64 worker image; SDK `0.2.117`. Verdicts:

- s1 **PASS**: `query()` completes a trivial turn against OpenRouter in ~4–7 s;
  `ANTHROPIC_API_KEY: ""` + `ANTHROPIC_AUTH_TOKEN` Bearer auth works. But the
  spawned "CLI" is the SDK's **native platform binary** (its optional
  `…-{platform}-{arch}[-musl]` packages; no `cli.js` in 0.2.117), so
  `executable: 'bun' | 'node'` is inert on the default path — the bun-vs-node
  question dissolves.
- s2 **REPLACES**: `Options.env` replaces the subprocess env (a one-var env
  reached the CLI as exactly that var; no `PATH`/`HOME`). The query env
  builder must spread `process.env` under the model-client vars and set an
  ephemeral `CLAUDE_CONFIG_DIR`.
- s3 **musl-first trap**: `bun install --production` in the Debian image
  installs both linux-x64 variants, the SDK resolves **musl before glibc**,
  and the musl binary cannot exec on glibc — a real in-image `query()` failed
  at spawn. Fix proven in-image: pin `pathToClaudeCodeExecutable` to the glibc
  platform binary (resolved with `{ paths: [<sdk dir>] }`), after which a full
  live in-image turn passed. Resolve + verify once at worker boot.
- s4 **PASS**: `tools: []` + `settingSources: []` + in-process MCP server +
  `allowedTools` + `dontAsk` is fail-closed: init tool list contains only the
  MCP tools, the allowlisted tool runs, an unlisted tool is auto-denied
  without prompting or hanging (`result.permission_denials` records it).
- s5 **PASS with a wiring rule**: `interrupt()` halts a **string-prompt** turn
  and the stream self-terminates (~3 s) via an `is_error` result + thrown
  stream error — `RunLoop.finish` already remaps abort+throw to `canceled`. A
  **held-open streaming input never ends** after interrupt; `startRunQuery`
  must pass the user message as a plain string.
- s6 **PASS**: the terminal `result` carries `session_id`/`is_error`/`subtype`
  with `result` (success) / `errors` (error) as `agent-stream.ts` assumes;
  `mirror_error` is a **real emitted shape** (a rejecting `SessionStore.append`
  produced `system/mirror_error` messages), not a phantom.
- s7 **PASS**: a custom `SessionStore` + `resume` restored the transcript on a
  simulated fresh worker (fresh `CLAUDE_CONFIG_DIR`); `projectKey` is the
  dash-sanitized cwd and byte-stable across same-cwd queries; the resumed turn
  keeps the same `session_id`.

Acceptance (met):

- s1–s7 answered; the s2/s3 flips and the s5 wiring rule are recorded here and
  in ADR-0006, and are folded into Tasks 9.5–9.7 below. The spike directory is
  deleted.

### Task 9.2: Build the Custom E2B Template — DONE 2026-07-10

`Grep`/`Glob` shell out to `rg` and `python3`, which the `base` template lacks.

- an E2B template that installs `rg`, confirms `python3`, and pins the toolchain.
- its id is `WORKER_E2B_TEMPLATE` (validated at config load).

Acceptance:

- a sandbox created from the template runs `rg --version` and `python3 --version`.

Built with the e2b Template SDK (`apps/agent-worker/e2b-template/`,
`bun run template:build` / `template:verify`) as alias `mymemo-agent-sandbox`:
`e2bdev/base` pinned by manifest digest, ripgrep 14.1.1 installed from the
sha256-verified release deb, python3 confirmed at build time (the base ships
3.11.6 — only `rg` was missing). Acceptance verified live 2026-07-10: a
sandbox created from the template ran both commands.

### Task 9.3: Remove Snapshots (ADR-0007)

Rip out the snapshot layer before building provisioning on the simpler model.

Tests first:

- `RunLoop.finish()` terminalizes `done` without a snapshot barrier.
- provisioning has no restore-from-snapshot path.

Changes:

- delete `snapshot-barrier.ts` and its call in `finish()`; drop the dirty flag
  and the `dirty_uncheckpointed` state and recovery.
- migration: drop `latest_snapshot_id`, `previous_snapshot_id`,
  `workspace_checkpoint_status` from `conversation_runtime`; remove the runtime
  helpers that write them and `WORKER_SNAPSHOT_RETENTION_MS`.
- retarget the cleanup loop to orphan + deleted-conversation sweeps only.

### Task 9.4: SandboxProvisioner and E2B Clients

The E2B-facing seam `startRunQuery` composes with (unit tests inject a fake).

Tests first:

- promote `E2BCommandClient` from `bash-tool.e2b.test.ts` to production; the
  test imports the production class.
- a new `E2BFileClient` (`SandboxFileClient` over `sandbox.files` +
  `sandbox.commands.run`) passes the file-tools integration contract.
- `provisionForRun` returns `{ sandboxId, isNew, workspaceRoot, commandClient,
  fileClient, renew(), dispose() }`; `dispose()` stops renewal (the sandbox
  idle-pauses), never kills the live workspace.

Verify:

- a live E2B test (skipped without `E2B_API_KEY`) exercises the real file
  client: `rg`-backed `Grep`, `python3`-backed `Glob`, read/write round-trip.

### Task 9.5: startRunQuery Orchestration

Compose provisioning, the fence, session config, and the query.

Tests first:

- reads the run's `run_started` event (new `loadRunStartedTx` helper) for the
  message + frozen scope; message → prompt, scope → `documentScope`.
- provisioning: ensure the runtime row (idempotent `createConversationRuntimeTx`)
  → connect if `sandboxId` set and not tainted → else create fresh; a new
  sandbox is written via fenced `updateRuntimeSandboxTx`.
- on `RunFenceError` after creating a new sandbox: `dispose`/kill it,
  `recordOrphanSandboxTx` on kill failure, abandon the run.
- a tainted pointer goes straight to a fresh sandbox and orphan-records the old
  one; every pointer replace orphan-records the prior sandbox.
- a per-run renewal timer pushes `setTimeout(now + WORKER_SANDBOX_IDLE_MS)` on a
  monotonic deadline; renewal failure aborts a linked controller → the run ends
  `error`, never `done`.
- the query is built with `tools: []`, `settingSources: []`,
  `permissionMode: 'dontAsk'`, `allowedTools` = the MCP tool names, the static
  system prompt, `env`/`model` from `buildModelClientConfig` — the model-client
  vars spread over `process.env` plus an ephemeral `CLAUDE_CONFIG_DIR`, because
  `Options.env` replaces the subprocess env (spike s2) — the boot-verified
  `pathToClaudeCodeExecutable` (spike s3), `mcpServers` = the run's executor
  tools, the linked `abortController`, `sessionStore`/`cwd`/`resume` from
  `buildAgentSessionQueryConfig`, and the user message as a **plain string**
  prompt — never a held-open input stream, which hangs after `interrupt()`
  (spike s5).
- the processor returns real `{ workspaceDirty: false, sandbox: null }` (no
  snapshots), `managedCommandRunning: false`, and the resume `agentSession`.

Verify:

- unit tests inject a fake `SandboxProvisioner` + fake SDK query (no
  credentials); the fence/orphan/renewal logic is deterministic.

### Task 9.6: Swap the Processor, Config, and Image

Tests first:

- `index.ts` wires `createSdkRunProcessor(startRunQuery)`, not the synthetic one.
- boot resolves `pathToClaudeCodeExecutable` to the SDK's **glibc** linux
  platform binary (`require.resolve("@anthropic-ai/claude-agent-sdk-linux-
  {arch}/claude", { paths: [<sdk package dir>] })`) and fails fast if it is
  missing or does not exec (spike s3: the SDK's own musl-first default fails
  in the Debian-based image).
- config adds `WORKER_E2B_TEMPLATE`, `WORKER_SANDBOX_IDLE_MS` (default 5 min),
  and env-configurable `WORKER_FILE_GREP_MAX_RESULTS`,
  `WORKER_FILE_GLOB_MAX_RESULTS`, `WORKER_FILE_READ_MAX_BYTES`,
  `WORKER_BASH_TIMEOUT_MS`, `WORKER_BASH_MAX_OUTPUT_BYTES` (each with a default).
- `finish()`'s failure branch logs the full error worker-side and writes a
  generic client `error` message.
- command audit binds to the structured logger with the full run binding.

Changes:

- Dockerfile: `mkdir -p /workspace && chown bun:bun /workspace` before
  `USER bun`; the worker `mkdir -p`s the per-conversation cwd before `query()`.

### Task 9.7: Live Smoke and Image Check

Acceptance:

- a live smoke test (real `query()` against OpenRouter + E2B, credentialed):
  create conversation → `user.message` → a turn with a tool call hitting E2B →
  assistant text streamed as `run_events` → `run_done`; a second turn resumes
  the session and reconnects to the same sandbox with files intact.
- a credential-free image check: `docker run <image>` resolves **and execs**
  the pinned glibc SDK CLI binary (`--version`) — the musl-first
  platform-binary trap and `--production` prune regression guard the spike
  proved once.

