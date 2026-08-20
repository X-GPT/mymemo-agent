# Production AgentCore Dispatch and Runtime

This Terraform root owns the shared production AgentCore execution boundary:

- the encrypted standard Dispatch queue and alarm-only DLQ;
- the batch-size-one consumer Lambda and enabled SQS event-source mapping;
- the fail-closed `/mymemo/agentcore-dispatch/prod/enabled` SSM parameter;
- the digest-pinned ARM64 AgentCore Runtime and immutable Runtime ECR repository;
- the Runtime/consumer private network, zonal NAT egress, and IAM resources; and
- the four production Dispatch paging alarms.

The state remains independent from the ordinary MyMemo production and Fargate
state. `shared.tf` reads that state for existing VPC, database, Redis, artifact,
and service-security-group inputs; this root never imports or recreates those
resources. The S3 backend intentionally retains the historical
`mymemo-agent/agentcore-canary-prod.tfstate` key because that is the state which
owns the production resources; changing the key would create a second,
unmanaged stack.

## Publisher-service boundary

The dedicated Dispatch publisher ECS service is owned by `infra/terraform` and
ADR-0027, not by this root. This root contains no publisher Lambda, EventBridge
repair schedule, publisher role, ECS service, or task definition. The publisher
service consumes this root's production queue, KMS alias, and SSM parameter by
their agreed names and emits `PendingAgeMs`, `PublisherErrors`, and informational
`PublisherLockNotAcquired` metrics in `MyMemo/AgentCoreDispatch`.
Production keeps the publisher at desired count one.

`agent-worker` receives no SQS, SSM, KMS, or publisher lifecycle authority. It
continues to own global queued-Run expiration and Reclamation for both execution
runtimes during coexistence.

## Runtime and consumer posture

The Runtime and consumer read the agent-worker configuration from the ordinary
agent Terraform state: the passwordless agent DB URL plus the RDS password
secret, the KB, OpenRouter, E2B, and Redis secret ARNs, and non-secret model,
artifact, and alarm settings. No GitHub repository variable configures this
stack. Their roles read only current secret versions and the Runtime writes
Downloadable artifacts through the standard `objects/` namespace with the same
multipart, replace, and delete operations available to the Fargate worker. The
consumer has no reserved-concurrency cap; queue batch size remains one, partial
batch responses stay enabled, and the queue values match the shared production
invariants in `apps/agentcore-dispatch-consumer/src/invariants.ts`.

Each private Runtime subnet has a same-AZ NAT Gateway in the existing shared
public subnet layout and an explicit `0.0.0.0/0` route. This supplies the AWS API
and internet egress required by the consumer, OpenRouter, and E2B. The guarded
post-deploy inspection verifies every private route is active and targets an
available NAT Gateway in the expected public subnet.

The SQS mapping is enabled in the deployed stack while the SSM parameter begins
`disabled` and ignores value drift. That leaves the consumer and Runtime ready
but fail-closed until an operator enables Dispatch. The SSM value is an
operational control and must not be toggled by a routine Terraform apply.

## Production alarms

Every alarm routes to the required `alarm_action_arns` production SNS
destination:

- `PendingAgeMs` at one minute is the primary paging symptom for stuck
  publication; the publisher emits it on every lock-owning tick, including zero
  when no work is pending, so missing data pages when that heartbeat disappears;
- `PublisherErrors` pages only after errors occur in three of five minutes;
- `PoisonDispatch` pages on invalid work rejected by the consumer; and
- visible DLQ depth pages at one message.

`PublisherLockNotAcquired` is expected during rolling overlap and remains
informational telemetry. There is no alarm for it.

## GitHub Actions deployment

Use the full
[AgentCore rollout and incident runbook](../../docs/runbooks/agentcore-rollout.md)
for cutover preconditions, control changes, staged rollout, incident response,
and disposable-Conversation rollback.

The production rename and ECR migration are complete. Routine deployment no
longer contains legacy queue checks, repository copying, targeted Terraform
applies, or a local deploy command.

The GitHub OIDC role must include the AgentCore permissions declared by
`infra/bootstrap-iam`; apply that bootstrap root once before the first release
after a permission change. The ordinary **Release deploy** workflow then owns
the complete coordinated release. Its ordinary Terraform apply publishes the
agent-worker configuration outputs before the independent AgentCore root reads
them.

The release workflow assumes `mymemo-agent-github-actions-deploy` through
GitHub OIDC and verifies account `637423444544`. After the compatible schema
migration it builds and checks the ARM64 Runtime image, pushes it to the
immutable production repository, packages the consumer Lambda with the pinned
RDS CA bundle, classifies the steady-state Terraform plan, and rejects every
resource deletion or replacement. After apply it enforces MMDSv2 through the
AWS control-plane API until the Terraform provider supports the field, waits
for the Runtime and `DEFAULT` endpoint, verifies the deployment, then rolls the
publisher and other ECS services.

Routine deployment reads the SSM Dispatch control before changing the Runtime
and verifies the exact value afterward. It accepts both `enabled` and
`disabled`, never changes the value, and does not require empty queues. Plan and
inspection evidence is retained as a GitHub Actions artifact for 30 days.

The coordinated production order is:

1. apply the ordinary Terraform root so shared outputs and ECS task definitions
   are current;
2. run the compatible schema migration;
3. deploy this consumer/Runtime stack while preserving the SSM control;
4. roll chat-api, agent-worker, and the dedicated publisher service at desired
   count one together;
5. during first cutover only, enable the SSM Dispatch control;
6. run the ordinary synthetic Conversation smoke; and
7. stage the runtime gate rollout.

Ordinary releases keep schema, envelope, publisher, consumer, and Runtime
compatibility coordinated even though the publisher image and task definition
are independently rollbackable. Rollback is a reviewed revert on `main`
followed by **Release deploy**. Incident shutdown reverses authority first:
disable SSM, turn the runtime gate off, then roll binaries.
