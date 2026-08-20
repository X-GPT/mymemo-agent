# Unify the production Terraform state

Status: accepted (2026-08-19). Supersedes ADR-0021's independent-state
consequence for the now-production AgentCore path.

The ECS applications, dedicated Dispatch publisher, consumer Lambda, and
AgentCore Runtime share `infra/terraform` and the
`mymemo-agent/prod.tfstate` backend. They use one AWS provider line
(`>= 6.50, < 7.0`) and one Release deploy because their database schema,
dispatch envelope, and executable versions have one compatibility cycle.

This is a lifecycle boundary, not a process or authority merger. The publisher,
consumer, Runtime, chat-api, and agent-worker keep their separate compute and
IAM roles. The SSM Dispatch parameter remains an operator-owned fail-closed
control whose value Terraform ignores after creation.

One state does not mean one undifferentiated apply phase. An ordinary release
first produces and classifies the complete plan, then applies a narrowly
targeted and separately classified migration task definition. After the
migration succeeds, it re-plans and applies the complete state and rolls ECS.
This preserves schema-before-code ordering without a second backend or a human
pause. The one-time empty ECS bootstrap additionally requires Dispatch disabled
because the initial base-infrastructure apply precedes the migration.

The release classifier has two review lanes. Exact routine ECS task-definition,
consumer-code, and Runtime-image updates are the unattended application lane.
All other creations, deletions, replacements, IAM changes, and infrastructure
updates are the manually confirmed infrastructure lane. Replacement is not a
universal error: Terraform lifecycle rules prevent destruction only for durable
Dispatch queues, its KMS key and SSM control, and the immutable Runtime image
repository. Removal from Terraform state remains a hard rejection.

The existing AgentCore addresses were moved from the historical
`mymemo-agent/agentcore-canary-prod.tfstate` backend into the production state
before the unified release path was enabled. The historical state now owns no
managed resources. S3 object versions retain the migration's recovery record.

## Considered options

- **Keep two roots and apply them sequentially.** Rejected because it preserves
  duplicate provider configuration, remote-state coupling, two plan policies,
  and a false lifecycle boundary for components that always ship together.
- **Apply the complete unified plan before migration.** Rejected because an
  enabled consumer mapping or existing Runtime traffic could execute new code
  against the old schema.
- **Reject every AgentCore deletion or replacement.** Rejected because Runtime
  and Lambda replacement can be legitimate reviewed infrastructure work.
  Durable state receives resource-specific lifecycle protection instead.
- **Pause every release or require Dispatch disabled.** Rejected for routine
  deployment. Re-planning after migration provides ordering, and the live SSM
  value is preserved. Only the one-time empty bootstrap needs the stronger
  disabled precondition.

## Consequences

- AgentCore resources can directly reference the production database, secrets,
  artifact bucket, Redis, network, alarms, queue, KMS key, and SSM parameter;
  the `mymemo_agent` remote-state dependency is removed.
- Provider upgrades and drift review happen once for the whole production
  stack.
- A normal release can update all executable surfaces automatically while
  infrastructure mutations remain explicit and reviewable.
- The historical backend is retained only as a recovery artifact with no
  managed resources; it is not an active Terraform root.
