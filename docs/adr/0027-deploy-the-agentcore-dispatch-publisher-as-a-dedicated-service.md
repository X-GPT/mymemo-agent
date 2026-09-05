# Deploy the AgentCore Dispatch publisher as a dedicated service

Status: accepted (2026-08-17). Amends ADR-0025 and supersedes ADR-0026's
initial compute-home consequence.
Amended (2026-08-20) by
[ADR-0029](./0029-recover-production-releases-by-rolling-forward.md), which
retains independent publisher control but supersedes independent binary
rollback as a production recovery procedure.
Amended (2026-08-22) by
[ADR-0031](./0031-make-agentcore-the-sole-execution-runtime.md): Fargate
coexistence ended, and `agent-maintenance` became the sole global expiration,
Reclamation, and cleanup owner. The publisher remains independently bounded and
owns none of those responsibilities.

Superseded (2026-09-05) by [ADR-0035](./0035-serve-chat-through-a-lambda-front-and-a-code-interpreter-hand.md): the dedicated dispatch publisher retires at the v1 cutover.

AgentCore Dispatch publication runs in one dedicated long-lived ECS service,
not in the Conversation-serving agent-worker process. The service has its own
app, filtered image, process lifecycle, task and execution roles, security
group, logs, and task definition; it owns the fail-closed SSM gate, bounded
Postgres outbox publication, and SQS send authority, but never acquires
Conversation Ownership or executes Runs. This isolates publisher failures and
AWS capabilities from Conversation execution without changing ADR-0026's
single advisory-locked loop, at-least-once delivery, or seconds-scale healthy
publication latency.

The deployment has one ECS service with desired count one in steady state.
Operators may deliberately set it to zero, and old and new tasks may overlap
during a rolling deploy; the tick-scoped advisory lock, rather than task count,
ensures that only one publishing critical section runs. During coexistence,
Fargate agent-worker remained the single global expiration and Reclamation
runner, as ADR-0023 and ADR-0025 required.

This is a process, dependency, and AWS-capability boundary, not a complete
trust or release boundary. The publisher initially retains the shared writable
agent database credential, unrestricted outbound egress, and the coordinated
release train. Its image and task definition are independently deployable, but
ADR-0029 supersedes the earlier independently rollbackable consequence:
production binary corrections remain coordinated so schema, envelope,
publisher, and consumer compatibility move together.

On termination the publisher stops beginning ticks and batches, bounds SSM and
SQS operations below the ECS stop timeout, and lets the current send/confirm
unit settle. Forced termination still releases the connection-scoped advisory
lock, and an interrupted send remains safe through at-least-once delivery and
Durable acquisition. Invalid bootstrap configuration ends the process;
transient tick failures keep the loop alive, emit publisher-error telemetry,
and rely on pending age as the primary paging symptom. A task that does not
acquire the advisory lock emits informational `lock_not_acquired` telemetry;
it did not lose a lock it previously held.

## Considered options

- **Run the publisher inside agent-worker.** Rejected because it grants the
  Conversation executor unrelated SSM, SQS, and KMS authority and couples
  publisher dependencies, bootstrap, failure, and shutdown to execution.
- **Run a publisher sidecar in the agent-worker task.** Rejected because an ECS
  task shares one task role and lifecycle, so the sidecar does not establish
  the selected authority or failure boundary.
- **Run a scheduled Lambda publisher.** Rejected by ADR-0026 because the
  scheduling floor cannot provide seconds-scale publication without restoring
  a second immediate-publish path.
- **Run two steady-state publisher tasks.** Rejected for now because durable
  backlog and ECS replacement already preserve correctness, while a permanent
  standby adds cost and continuous expected lock contention. Revisit if
  seconds-scale latency becomes a fault-state objective.
- **Release the publisher autonomously.** Rejected for now because independent
  cadence creates a compatibility matrix across the database schema, envelope,
  publisher, and consumer without improving the selected runtime boundary.
- **Create a general AgentCore control-plane service.** Rejected during
  coexistence because global expiration and Reclamation deliberately remained
  in Fargate; extracting them belonged to a later Fargate-retirement decision.

## Consequences

- agent-worker held no Dispatch publication code, configuration, queue
  authority, or responsibility, but continued global expiration and
  Reclamation for both execution runtimes during coexistence. ADR-0031 moved
  those global responsibilities to `agent-maintenance` when Fargate retired.
- Publication latency is on the order of seconds while the service is healthy;
  task replacement may pause publication, with pending age and the queued-Run
  timeout exposing and bounding the degradation.
- A publisher-specific Postgres role, destination-restricted egress, and an
  autonomous release cadence are possible later hardening steps, not claims of
  this decision.
- Publisher metric emission belongs to the publisher delivery slice; production
  pending-age and sustained-error alarms belong to the shared dispatch
  infrastructure slice. `lock_not_acquired` remains informational.
