# Unify the production Terraform state

Status: accepted (2026-08-19). Supersedes ADR-0021's independent-state
consequence for the now-production AgentCore path.

Amended (2026-08-20): immutable image repositories are build prerequisites,
not executable release resources. The existing `infra/ecr` bootstrap root owns
all four repositories, including `mymemo/agentcore-runtime`; the production
root resolves the Runtime repository by its exact name.

Amended (2026-08-22) by the Fargate-retirement release: `agent-worker` is now a
shared code package rather than deployed compute. `agent-maintenance` owns its
former global maintenance responsibilities. The targeted pre-migration apply
includes the migration task definition and its Terraform-declared prerequisites
without a separate plan classifier.

The ECS applications, dedicated Dispatch publisher, consumer Lambda, and
AgentCore Runtime share `infra/terraform` and the
`mymemo-agent/prod.tfstate` backend. They use one AWS provider line
(`>= 6.50, < 7.0`) and one Release deploy because their database schema,
dispatch envelope, and executable versions have one compatibility cycle.
The separate `infra/ecr` state owns only durable image storage that must exist
before those executable artifacts can be built and the unified plan can be
created; it does not independently deploy any executable surface.

This is a lifecycle boundary, not a process or authority merger. The publisher,
consumer, Runtime, chat-api, and `agent-maintenance` keep their separate compute
and IAM roles. `agent-worker` supplies shared Runtime and maintenance code but
is not deployed. The SSM Dispatch parameter remains an operator-owned
fail-closed control whose value Terraform ignores after creation.

One state does not mean one undifferentiated apply phase. Every release is
manually dispatched from `main` with the production confirmation phrase. It
first produces the complete plan, then applies a narrowly targeted and
saved plan containing the migration task definition and its Terraform-declared
prerequisites. After the migration succeeds, it re-plans and applies the
complete state and rolls ECS. This preserves schema-before-code ordering
without a second backend. The one-time empty ECS bootstrap additionally
requires Dispatch disabled because the initial base-infrastructure apply
precedes the migration.

Every complete Terraform plan receives the same operator authorization; there
is no automatic application lane or attribute-level release classifier.
Replacement is not a universal error: Terraform lifecycle rules prevent
destruction only for durable Dispatch queues, its KMS key and SSM control, and
the immutable Runtime image repository in the ECR root.

The existing AgentCore addresses were moved from the historical
`mymemo-agent/agentcore-canary-prod.tfstate` backend into the production state
before the unified release path was enabled. The historical state now owns no
managed resources. S3 object versions retain the migration's recovery record.
The Runtime repository is subsequently imported into
`mymemo-agent/ecr-prod.tfstate` before the production root forgets its old
address without destroying the repository. The ordered handoff permits a
temporary duplicate state record if a release stops between those operations,
but never a period in which the physical repository is deleted or recreated.

## Considered options

- **Keep separate executable roots and apply them sequentially.** Rejected
  because it preserves duplicate provider configuration, remote-state
  coupling, two plan policies, and a false lifecycle boundary for components
  that always ship together. The pre-existing ECR bootstrap root is different:
  it owns stable image storage and performs no executable deployment.
- **Apply the complete unified plan before migration.** Rejected because an
  enabled consumer mapping or existing Runtime traffic could execute new code
  against the old schema.
- **Reject every AgentCore deletion or replacement.** Rejected because Runtime
  and Lambda replacement can be legitimate reviewed infrastructure work.
  Durable state receives resource-specific lifecycle protection instead.
- **Automatically apply routine executable updates through a plan classifier.**
  Rejected because its security-sensitive attribute policy must track provider
  semantics. The shared release cycle can afford one explicit manual dispatch.
- **Require Dispatch disabled for every release.** Rejected because re-planning
  after migration provides ordering and the live SSM value is preserved. Only
  the one-time empty bootstrap needs the stronger disabled precondition.

## Consequences

- AgentCore resources can directly reference the production database, secrets,
  artifact bucket, Redis, network, alarms, queue, KMS key, and SSM parameter.
  The Runtime repository is resolved through an exact ECR data lookup after the
  bootstrap root is applied; no Terraform remote-state dependency is added.
- Provider upgrades and drift review happen once for the whole production
  stack.
- A normal release updates all executable surfaces together after an explicit
  manual dispatch; CI never applies production changes unattended.
- The historical backend is retained only as a recovery artifact with no
  managed resources; it is not an active Terraform root.
