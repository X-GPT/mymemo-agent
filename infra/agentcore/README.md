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
`mymemo-agent/agentcore-canary-prod.tfstate` key so the production rename updates
the existing resources instead of creating a second unmanaged stack.

## Publisher-service boundary

The dedicated Dispatch publisher ECS service is owned by `infra/terraform` and
ADR-0027, not by this root. This root contains no publisher Lambda, EventBridge
repair schedule, publisher role, ECS service, or task definition. The publisher
service consumes this root's production queue, KMS alias, and SSM parameter by
their agreed names and emits `PendingAgeMs`, `PublisherErrors`, and informational
`PublisherLockNotAcquired` metrics in `MyMemo/AgentCoreDispatch`.

`agent-worker` receives no SQS, SSM, KMS, or publisher lifecycle authority. It
continues to own global queued-Run expiration and Reclamation for both execution
runtimes during coexistence.

## Runtime and consumer posture

The Runtime environment carries exact Secrets Manager ARNs, never secret
values. Its role reads only those current secret versions and writes
Downloadable artifacts through the standard `objects/` namespace with the same
multipart, replace, and delete operations available to the Fargate worker. The
consumer has no reserved-concurrency cap; queue batch size remains one, partial
batch responses stay enabled, and the queue values match the shared production
invariants in `apps/agentcore-canary-dispatch/src/invariants.ts`.

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

## Guarded deployment

Use the full
[AgentCore rollout and incident runbook](../../docs/runbooks/agentcore-rollout.md)
for cutover preconditions, control changes, staged rollout, incident response,
and disposable-Conversation rollback.

Configure the repository variables named `AGENTCORE_*` that are read by
`scripts/deploy/deploy_agentcore.sh`, then run the command from a clean `main`
checkout that exactly matches `origin/main`:

```bash
scripts/deploy/deploy_agentcore.sh deploy-mymemo-agentcore-prod
```

An existing Runtime digest may be passed as the second argument for promotion or
rollback. The command uses only the mandatory `mymemo` AWS profile, verifies
account `637423444544`, requires the SSM control to be disabled, builds the
verified consumer package, proves both legacy queues have zero visible,
in-flight, and delayed messages, and classifies every Terraform plan. During
the one-time production rename it keeps both repositories Terraform-managed,
copies and verifies the deployed digest in the production repository, updates
the Runtime to a verified production-repository image, and only then removes
the legacy repository. Plan JSON/text, queue and rollback evidence, Runtime
version, and the idle production inspection are retained under
`dist/agentcore-deployment/`.

The coordinated production order is:

1. apply the compatible schema;
2. deploy chat-api with the runtime gate off;
3. deploy this consumer/Runtime stack idle and the dedicated publisher service
   with desired count one;
4. enable the SSM Dispatch control;
5. run the ordinary synthetic Conversation smoke; and
6. stage the runtime gate rollout.

Ordinary releases keep schema, envelope, publisher, consumer, and Runtime
compatibility coordinated even though the publisher image and task definition
are independently rollbackable. Incident shutdown reverses authority first:
disable SSM, turn the runtime gate off, then roll binaries.
