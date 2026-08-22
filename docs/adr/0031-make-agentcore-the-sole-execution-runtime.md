# Make AgentCore the sole execution runtime

Status: accepted (2026-08-21). Amends ADR-0025 and ADR-0029 by retiring
runtime selection, the Fargate creation fallback, runtime reassignment, and the
Execution runtime gate.

AgentCore is the sole supported execution runtime. Production's remaining
Fargate Conversations were permanently deleted before this decision, so there
is no legacy execution or migration path to preserve. Conversation creation
must produce AgentCore state without consulting Statsig, and every newly
admitted Run must record AgentCore Dispatch unconditionally. The SSM Dispatch
control remains; the Execution runtime gate no longer participates in rollout
or incident recovery.

Retirement is planned as two ordered releases so database migrations remain
compatible with old processes during rolling deployment. The first release is
implemented and deployed before work begins on the second. It retains
`execution_runtime` as an AgentCore-only compatibility marker and may continue
returning `executionRuntime: "agentcore"` in the public Conversation shape,
while removing runtime selection and conditional Dispatch. The following
retirement release removes the marker and the remaining Fargate Claim,
doorbell, deployment-readiness, and Run-serving machinery during controlled
maintenance, after every still-running process is independent of them and the
old worker is stopped. It removes the public `executionRuntime` field in a
coordinated client change and moves global queued-Run expiration, Reclamation,
and cleanup from agent-worker into a smaller, least-privilege agent-maintenance
ECS service. The service remains always running, preserves the existing
Reclamation cadence, and holds only the database, E2B-cleanup, and S3-deletion
authority its maintenance responsibilities require. Until that release,
agent-worker remains for those global maintenance responsibilities.

The second release is a controlled maintenance event because the old
agent-worker still reads the compatibility marker. With Dispatch paused, zero
Active Runs, and the old worker stopped, its migration removes the marker and
must refuse to proceed if any non-AgentCore Conversation exists. A migration
never deletes Conversations to satisfy that precondition. The new
agent-maintenance service starts after the compatible schema is installed.

Local development runs the AgentCore Runtime application rather than retaining
Fargate execution. A dedicated development-only Dispatch bridge app combines
the production-neutral publisher and consumer behavior in one process: it
polls the durable outbox, validates the dispatch, invokes the local Runtime
through `/invocations`, and handles the Acquisition receipt. It is excluded
from production images and deliberately omits SQS, Lambda, SSM, IAM, VPC, and
managed Runtime behavior; deployed smoke tests remain responsible for those
AWS boundaries. Local chat-api composition allows exposure without Statsig
through a separate entrypoint that cannot be selected by production
configuration. The bridge marks a local outbox record handled only after a
correlated Acquisition receipt; an invocation, validation, or receipt failure
leaves the record available for retry.

## Considered options

- **Keep the runtime gate dormant.** Rejected because it preserves a Fargate
  creation path and an operational control whose fallback no longer exists.
- **Remove the discriminator and all Fargate machinery in the first release.**
  Rejected because migrations run before old chat-api and agent-worker tasks
  leave service; those binaries still read the column and Fargate-specific
  database objects.
- **Keep Fargate for local development.** Rejected because local behavior would
  no longer exercise the supported Runtime application or its HTTP contract.
- **Emulate SQS and Lambda with LocalStack.** Rejected because commercial use
  requires a paid LocalStack license and the local queue boundary is not needed
  for interactive development.

## Consequences

- Runtime assignment is no longer a product or operator decision.
- The first release must prevent old gate-aware chat-api tasks from recreating
  Fargate state while the database invariant is narrowed to AgentCore-only.
- The public `executionRuntime` field is compatibility output during the first
  release, not evidence of an available runtime choice, and is removed with a
  coordinated frontend change in the second release.
- Fargate execution code and its broad worker authority remain temporary debt
  with an explicit deletion condition, not a supported fallback.
- Production images do not contain the local Dispatch bridge or its combined
  publisher-and-consumer dependency graph.
- Schema retirement fails closed on any remaining Fargate data and never uses
  destructive migration behavior to force the invariant.
