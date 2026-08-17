# Temporal for the AgentCore Production Canary

**Research date: 2026-08-13.** This note evaluates whether Temporal should replace parts of
MyMemo's operator-triggered, zero-user-traffic AgentCore production-canary design in
[spec #445](https://github.com/X-GPT/mymemo-agent/issues/445). All external claims are based
on first-party Temporal or AWS documentation current on the research date.

## Recommendation

Do **not** introduce Temporal for the initial production canary. Keep AWS Step Functions
Standard as the campaign orchestrator and retain the transactional Postgres outbox, SQS,
Lambda consumer, exact database acquisition, Conversation Ownership, and Reclamation design.

Temporal is technically capable of replacing Step Functions for the campaign. Its durable
Workflows, timers, Signals, Activities, retries, and Task Queues are a good fit for long-lived
application orchestration. The canary, however, is a finite, AWS-local, manually approved
workflow that runs for at most 45 minutes and is dormant most of the time. Step Functions
Standard already provides durable, auditable executions for up to one year with persisted
state between transitions and exactly-once workflow-execution semantics unless retries are
configured. It charges per transition and includes 4,000 transitions per month at no charge
([workflow types](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html),
[pricing](https://aws.amazon.com/step-functions/pricing/)).

Temporal would not solve the hardest correctness boundary: the atomic relationship between
Postgres Run admission and a request to execute that Run. It would add a second control plane,
a customer-operated Worker deployment, replay-compatible code/version management, new
credentials and networking, and at least a $100 monthly Temporal Cloud plan floor before
considering Worker compute. Temporal Cloud's Essentials plan is the greater of $100 per month
or 5% of usage spend, with Actions and storage metered separately
([Temporal Cloud pricing](https://docs.temporal.io/cloud/pricing)).

Re-evaluate Temporal during a later AgentCore user-traffic rollout only if durable
orchestration becomes a shared product/platform capability: many concurrent long-lived
workflows, durable human or external messages, complex compensations, or coordination across
multiple services. Those are Temporal's strengths; one occasional canary campaign does not
justify the platform cost.

## What Temporal could replace

| Current component | Temporal replacement | Assessment |
| --- | --- | --- |
| Step Functions Standard campaign | One `AgentCoreCanaryCampaign` Workflow with Activities, durable timers, and Signals | Technically clean, but not enough value to justify adoption for this canary. |
| Step Functions waits/polls and watchdog | Workflow timers plus idempotent observation/cleanup Activities; an abort Signal translated into durable MyMemo control actions | Strong fit. A Signal is better operator interaction than killing a runner, but the existing Campaign record and explicit abort already satisfy the requirement. |
| EventBridge minute repair invocation | A Workflow timer loop or Temporal Schedule that calls a pending-row recovery Activity | Possible, but still needs a live Temporal Worker to execute the Activity. A Schedule is unnecessary for a manually launched campaign. |
| SQS plus Lambda consumer | A Temporal Activity Task Queue polled by a bridge Worker that invokes AgentCore and waits for the Acquisition receipt | Possible only with a new bridge Worker. AgentCore is not a Temporal Worker, so this is not a direct substitution. |
| Launcher Lambda | The approved GitHub job could call a Temporal Client directly | Possible, but it would move a Temporal API key or mTLS credential into the GitHub path. Retaining a thin OIDC-invoked launcher preserves the existing AWS approval and credential boundary. |

Temporal Workflows are deterministic functions whose external I/O must run in Activities;
Activity results are recorded in Event History and replayed to reconstruct Workflow state
([TypeScript Workflow basics](https://docs.temporal.io/develop/typescript/workflows/basics)).
Task Queues persist Workflow and Activity Tasks while Workers are unavailable, dynamically
load-balance work across polling Workers, and require only outbound Worker connections
([Task Queues](https://docs.temporal.io/task-queue)). These properties can reproduce the
campaign control plane and the queue-to-consumer portion of dispatch.

They do not make AgentCore itself poll Temporal. Replacing SQS therefore requires a
customer-operated Worker that receives the Activity Task and invokes AgentCore. Keeping SQS
would make Temporal only the outer campaign orchestrator, leaving the current dispatch design
unchanged.

## What Temporal cannot replace without changing the authority model

### Postgres admission and the atomic intent record

A Temporal Client call is a remote service call; it cannot commit in the same transaction as
the Postgres `runs`, `run_events`, and Campaign writes. If admission remains a Postgres-first
operation, replacing `SendMessage` with `StartWorkflow` or `SignalWorkflow` merely changes the
second half of the dual write. A crash after the database commit and before Temporal accepts
the call can still strand the Run. The transactional outbox therefore remains required in the
current authority model; its publisher would target Temporal rather than SQS.

There is one **redesign**, not a drop-in replacement, that could eliminate the canary dispatch
outbox: start a uniquely identified Temporal Workflow first, then have an idempotent Activity
perform exact Postgres admission with deterministic Run/message IDs. If the Activity commits
but its completion is not recorded, Temporal retries it and exact admission returns the same
Run. That makes Temporal Workflow history the durable intent that precedes Postgres admission.
It reverses the settled Postgres-first control flow, changes Campaign authority and audit
semantics, invalidates ADR-0020's chosen boundary, and expands the blast radius of Temporal
unavailability. It is not warranted for this canary.

### Run authority and recovery

Temporal also cannot replace these MyMemo domain invariants merely by wrapping them in a
Workflow:

- immutable Conversation execution-runtime isolation;
- the exact acquisition transaction that locks Conversation before Run;
- the live Ownership epoch and lease used to fence every write;
- Run-at-most-once semantics across ambiguous delivery;
- durable interruption and Outcome precedence;
- runtime-agnostic Reclamation of expired Ownership;
- Agent-session, Workspace, Live Stream, transcript, and artifact rules.

These invariants govern database state shared with the unchanged Fargate runtime. Temporal
Activity delivery and retry are execution mechanisms, not a replacement for that shared
authority.

## Failure, retry, and cancellation semantics

### Workflow durability

Temporal persists Workflow Event History and reconstructs Workflow state by deterministic
replay. Workflows can remain open without an imposed execution time limit, while sufficiently
large histories must use Continue-As-New; Temporal Cloud limits a Workflow history to 51,200
events or 50 MB
([Workflow Execution](https://docs.temporal.io/workflow-execution),
[limits](https://docs.temporal.io/workflow-execution/limits)). The bounded five-scenario
campaign would be far below those limits.

If the Temporal Worker process dies, Workflow and Activity Tasks remain in the Task Queue and
can be picked up when a compatible Worker returns. This is stronger than tying campaign life
to a GitHub runner, but Step Functions already provides that independence without requiring a
MyMemo-operated workflow Worker.

### Activity retry is at least once

Temporal Activities are side-effecting application functions. They retry automatically by
default with exponential backoff and unlimited attempts; `maximumAttempts: 1` means one
attempt and no retry. Temporal explicitly expects Activity implementations to be idempotent
([Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)). A failed long-running
Activity restarts from the beginning unless heartbeat details are used as a checkpoint
([Activity timeouts and heartbeats](https://docs.temporal.io/develop/typescript/activities/timeouts)).

That default is dangerous if an Activity is treated as permission to create another model
execution. A Temporal implementation must preserve deterministic Run/message IDs and exact
database admission/acquisition. Activities that observe state or repeat idempotent control
operations may retry. Any operation that could cause a fresh model execution after an Outcome
must either disable automatic retry or reconcile authoritative Postgres state before doing
anything. Temporal must never implement “retry the scenario with a new Run.”

Step Functions has the same need for explicit retry design: `Retry` applies only when declared,
and retries are configurable by error, interval, attempt count, backoff, and jitter
([Step Functions error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)).
The settled spec's deterministic identities and no-Run-retry rule are correct under either
orchestrator.

### Cancellation is cooperative

Temporal cancellation is not a kill signal for detached AgentCore execution. A normal
Activity receives cancellation only through heartbeats and must cooperate with the request;
an Activity that does not heartbeat may receive it late or not while blocked. Cleanup logic
must rethrow cancellation for the Activity to appear canceled
([TypeScript cancellation](https://docs.temporal.io/develop/typescript/workflows/cancellation),
[Activity heartbeats](https://docs.temporal.io/develop/typescript/activities/timeouts#activity-heartbeats)).

After AgentCore emits Durable acquisition and the invoker disconnects, the actual model turn
continues outside the Temporal Activity call just as it continues outside the Lambda response.
A Workflow cancellation or abort Signal must therefore invoke MyMemo's durable Run
interruption, disable dispatch, resolve/reclaim Ownership, and run idempotent cleanup. It
cannot assume that cancelling the Workflow has terminated Tool/E2B or Runtime work.

## Deployment and operations

### Temporal Cloud still requires MyMemo Workers

Temporal Cloud operates the Temporal Service, but Workflow and Activity code runs in Workers
that MyMemo deploys and secures in its own environment
([Temporal Cloud security model](https://docs.temporal.io/cloud/security)). A production
TypeScript Worker is a long-lived polling process. Temporal's TypeScript SDK recommends a
prebuilt Workflow bundle, explicit Worker shutdown behavior, and a glibc-based Node image; it
does not support Alpine/musl
([run a TypeScript Worker](https://docs.temporal.io/develop/typescript/workers/run-worker-process)).

This repo is a Bun monorepo. The official TypeScript SDK says client-level functionality may
work on Bun, but Worker-level functionality depends on Node-specific native modules,
`worker_threads`, `vm`, `AsyncLocalStorage`, and `async_hooks`, and strongly discourages
running Workers outside authentic Node.js
([Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)). Adoption would add
a separately built and operated Node Worker runtime rather than simply adding a library to an
existing Bun service.

Temporal documents AWS Lambda Serverless Workers as a scale-to-zero option, but the feature is
Public Preview, requires Worker Versioning, and remains subject to Lambda's 15-minute
invocation limit
([Serverless Workers](https://docs.temporal.io/evaluate/serverless-workers),
[AWS Lambda Serverless Workers](https://docs.temporal.io/production-deployment/worker-deployments/serverless-workers/aws-lambda)).
Depending on a preview orchestration runtime while evaluating AgentCore would add avoidable
risk. The mature alternative is a long-lived ECS/Fargate Worker or a campaign-scoped Worker
whose startup, health, replacement, and shutdown must themselves be orchestrated.

### Networking, identity, and data

Temporal Cloud supports API-key or mTLS Namespace authentication, TLS 1.3 in transit, and
AES-256-GCM encryption at rest. Optional client-side Payload Codecs encrypt Workflow and
Activity payloads before they reach Temporal Cloud
([Temporal Cloud security](https://docs.temporal.io/cloud/security),
[codecs and encryption](https://docs.temporal.io/production-deployment/data-encryption)).
Namespace-scoped Service Accounts and API keys can constrain machine access
([Service Accounts](https://docs.temporal.io/cloud/manage-access/service-accounts),
[API keys](https://docs.temporal.io/cloud/api-keys)).

For private connectivity, Temporal Cloud supports AWS PrivateLink from a VPC in the same
region as the Namespace. Workers connect outward; Temporal cannot initiate a connection back
into the VPC. Connectivity Rules can enforce private-only Namespace access
([AWS PrivateLink connectivity](https://docs.temporal.io/cloud/connectivity/aws-connectivity)).
This is compatible with the canary's private network, but adds a VPC endpoint, DNS/SNI setup,
security-group policy, and Temporal credential rotation. Public egress avoids that
infrastructure but widens the network dependency.

Workflow inputs, Activity inputs/results, Signals, failures, and other payloads are persisted
in Event History unless encrypted. A minimal design should send identifiers and hashes, keep
prompts/documents/artifact bodies in MyMemo's existing stores, and apply a Payload Codec if
even those control payloads are sensitive. This mirrors the current content-free SQS envelope
principle.

### Dormant-canary fit and cost

The existing AWS design has no meaningful orchestration fee while dormant: Standard
Workflows charge per transition, SQS has no minimum fee and includes one million requests per
month, and Lambda charges for requests and duration
([Step Functions pricing](https://aws.amazon.com/step-functions/pricing/),
[SQS pricing](https://aws.amazon.com/sqs/pricing/),
[Lambda pricing](https://aws.amazon.com/lambda/pricing/)). Temporal Cloud instead has the
monthly plan floor plus Actions and active/retained Event History storage. An always-on Worker
adds compute; a scale-to-zero Worker adds startup and availability machinery or a Public
Preview dependency.

This difference is decisive for an operator-triggered canary that may sit unused for weeks.
Temporal's consumption pricing is attractive for an already-adopted platform with many
workflows, but poor justification for the first and only Workflow.

## Migration impact on the accepted spec and tickets

If Temporal were adopted **only as the campaign orchestrator**, the impact would be:

| Artifact | Impact |
| --- | --- |
| [#447](https://github.com/X-GPT/mymemo-agent/issues/447) | Unchanged. |
| [#448 shared Run serving](https://github.com/X-GPT/mymemo-agent/issues/448) | Unchanged. |
| [#449 Campaign/admission/outbox](https://github.com/X-GPT/mymemo-agent/issues/449) | Campaign and atomic admission/outbox remain. Add a stable Temporal Workflow ID/run reference beside or instead of the Step Functions execution ARN. |
| [#450 dispatch/acquisition](https://github.com/X-GPT/mymemo-agent/issues/450) | Unchanged if SQS stays. If Task Queues replace SQS, rewrite publisher, envelope/receipt transport, poison handling, DLQ expectations, Lambda acknowledgement, visibility timeout, and repair semantics; exact acquisition remains. |
| [#451 detached Runtime](https://github.com/X-GPT/mymemo-agent/issues/451) | Shared serving and detachment remain. If SQS is removed, the invoker becomes a Temporal Activity Worker rather than Lambda, but AgentCore still returns a typed committed Acquisition receipt. |
| [#452 dormant infrastructure](https://github.com/X-GPT/mymemo-agent/issues/452) | Replace Step Functions resources only in the narrow variant. A full dispatch replacement also removes SQS/Lambda/EventBridge resources but adds Temporal Namespace/account configuration, credentials, Worker compute, PrivateLink/DNS or public egress, monitoring, and Worker version deployment. Dormant-cost acceptance criteria must change. |
| [#453 baseline orchestration](https://github.com/X-GPT/mymemo-agent/issues/453) | Major rewrite from ASL/Lambda tasks to a Temporal Workflow/Activities/Signals. Keep deterministic identities, Postgres observation, signed report, explicit abort, watchdog behavior, and cleanup. |
| [#454 remaining scenarios](https://github.com/X-GPT/mymemo-agent/issues/454) | Major orchestration rewrite, but scenario gates and no-Run-retry rules remain. Temporal cancellation must be translated into the existing durable interruption and cleanup operations. |

ADRs 0019, 0022, 0023, and the Run-serving portion of 0024 remain valid. ADR 0020 remains
valid in the Postgres-first design. ADR 0021's independent-deployment principle remains, but
its resource inventory expands to include Temporal connectivity/credentials/Worker compute.
ADR 0024 would need a superseding decision naming Temporal rather than Step Functions. A
Task-Queue dispatch replacement would additionally require a superseding decision for ADR
0020 and substantial changes to tickets #450–#452.

Because implementation has not begun, adopting Temporal now would avoid code migration, but
it would reopen settled architecture and ticket contracts. The replacement does not reduce
the domain-critical database work; it mainly exchanges a small serverless AWS orchestrator
for a general workflow platform.

## If Temporal is chosen anyway

Use the narrowest variant:

1. Keep GitHub Environment approval and an OIDC-invoked launcher Lambda.
2. Start `AgentCoreCanaryCampaign` with a stable Campaign-derived Workflow ID. Temporal permits
   at most one open Workflow Execution for a Workflow ID
   ([Workflow ID and Run ID](https://docs.temporal.io/workflow-execution/workflowid-runid)).
3. Keep Postgres Campaign, transactional admission/outbox, SQS, exact acquisition, Lambda
   consumer, Ownership, and Reclamation unchanged.
4. Implement bounded idempotent Activities for provisioning, exact admission, observation,
   fault injection, evidence, reporting, and cleanup. Configure retry per Activity; never let
   a retry generate a new Run or model turn.
5. Use a durable Signal for operator abort, translating it into disable-first MyMemo control
   actions and canonical interruption/cleanup.
6. Run one versioned Node Worker in ECS/Fargate during active campaigns, with automatic
   replacement while a Campaign is active. Scale it to zero only after the Workflow and
   cleanup are terminal.
7. Keep workflow payloads content-free and encrypted; prefer same-region PrivateLink if the
   security policy prohibits public egress.

This variant captures Temporal's orchestration benefits while preserving every settled Run
correctness boundary. It also demonstrates why Temporal is not the economical choice here:
nearly all existing canary infrastructure and database protocol remain, while a new workflow
platform and Worker fleet are added.
