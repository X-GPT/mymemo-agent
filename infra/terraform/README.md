# mymemo-agent Terraform

This Terraform root owns the AWS resources for `mymemo-agent` while consuming
the existing `mymemo-service` network. It deliberately does not create a VPC,
subnets, or ECS cluster.

## Shared Network Contract

Shared infrastructure is consumed from the `mymemo-service` Terraform remote
state at `s3://mymemo-terraform-state-bucket/mymemo/staging.tfstate`. Do not
duplicate VPC, subnet, or ECS cluster IDs in this repo's deploy config.

The agent stack reads these from remote state when exposed by
`mymemo-service`. For values that the current `mymemo-service` state does not
yet output directly, it derives them from existing remote-state outputs with AWS
data sources instead of duplicating IDs in this repo.

- ECS subnet IDs from `ecs_subnet_ids`
- VPC ID from `vpc_id`
- ECS cluster ARN from `ecs_cluster_arn`, falling back to `ecs_cluster_name`

Fallback AWS data sources are conditional: Terraform only evaluates them when
the direct remote-state output is absent and the fallback input is present.

## Agent-Owned Resources

- ECR repositories for `mymemo-agent-chat-api` and `mymemo-agent-worker` in the
  separate `infra/ecr` Terraform root
- dedicated RDS Postgres instance for writable agent state
- single-node ElastiCache Redis replication group for disposable live previews
- ECS Fargate task definitions and services for chat-api and agent-worker
- agent DB migration task definition
- service security group inside the shared VPC
- internal agent-owned ALB, ALB security group, listeners, and chat-api target group
- IAM execution/task roles for the agent tasks
- CloudWatch log groups and baseline alarms

## Secrets

This Terraform root always creates a dedicated RDS Postgres instance for
`AGENT_DATABASE_URL`. RDS manages the master password in Secrets Manager; ECS
receives `AGENT_DATABASE_URL` without a password plus `DB_PASSWORD` from the
RDS-managed secret. This is the writable agent state database for conversations,
leases, run state, and migrations. It is separate from the read-only KB database
URL used by `agent-worker`.

Terraform also generates the live preview cache authentication token and stores
the complete `rediss://` connection URL in the Terraform-managed
`<name_prefix>-<environment>-REDIS_URL` Secrets Manager secret. ECS injects that
secret as `REDIS_URL` into `chat-api` and `agent-worker` only. It is not added to
the migration task or any E2B sandbox configuration, and neither the credential
nor the complete URL is exposed as a Terraform output.

Other secret values are not committed. Terraform resolves conventional Secrets
Manager names to ARNs at plan/apply time, and ECS task definitions consume those
resolved ARNs:

- `KB_DATABASE_URL`
- `STATSIG_SERVER_SECRET`
- `OPENROUTER_API_KEY`
- `E2B_API_KEY`

For the first deploy, `KB_DATABASE_URL` may be bootstrapped from the existing
`mymemo-service` database role:

```sh
scripts/deploy/create_bootstrap_kb_database_secret.sh
```

That script creates or updates `mymemo-agent-prod-KB_DATABASE_URL` and prints
only the secret name. This is a temporary bootstrap shortcut: the secret uses
the existing service DB role, so the database does not enforce read-only access.
Replace it with a read-only KB role before broad exposure.

`chat-api` currently receives `E2B_API_KEY` because its deployed code still
validates that variable when `SANDBOX_PROVIDER=e2b`. The final split-runtime
boundary should remove that from chat-api once sandbox creation moves fully to
`agent-worker`.

## Redis Live Preview Lane

The Redis cache is transport infrastructure for provisional Assistant text,
not a source of truth. It is a single small node with no replicas, Multi-AZ
failover, automatic snapshots, final snapshot, or backup retention. The cache
is reachable on its TLS port only from a dedicated client security group
attached to the trusted `chat-api` and `agent-worker` services; the migration
task does not receive that group. ElastiCache does not receive a public address
or a public ingress rule. Authentication and in-transit encryption are
mandatory.

Before the first cache plan in an existing environment, reapply
`infra/bootstrap-iam` with the admin profile as shown below. That updates the
GitHub Actions deploy role with the ElastiCache permissions used by this root.

Redis availability must not participate in chat-api or agent-worker readiness.
Missing, invalid, or unreachable Redis configuration must degrade only live
previews and must not prevent either service from booting or staying healthy.
The durable Postgres path remains sufficient for successful Runs, durable
Assistant messages, terminal Outcomes, and replay.

Set `live_preview_enabled=false` to omit `REDIS_URL` from both trusted service
task definitions without deleting the cache. Live telemetry is converted into
CloudWatch metrics with bounded service/signal/outcome dimensions; the alarms
require repeated five-minute breaches and never feed service health. See
[`docs/runbooks/live-preview.md`](../../docs/runbooks/live-preview.md) for
diagnosis, disable, and restore procedures.

## Release Deploy Config

This repo owns its GitHub Actions deploy role in the one-time bootstrap root:

```sh
AWS_PROFILE=mymemo terraform -chdir=infra/bootstrap-iam init
AWS_PROFILE=mymemo terraform -chdir=infra/bootstrap-iam apply -var-file=prod.tfvars
```

That creates `mymemo-agent-github-actions-deploy`, trusted only by the
`X-GPT/mymemo-agent` GitHub environment named `prod`. Run this bootstrap locally
with an admin AWS profile before the first GitHub Actions deploy.

Terraform-owned production inputs live in checked-in
`infra/terraform/prod.tfvars`. The GitHub Actions workflow sources
`infra/deploy/prod.env` for CI/deploy settings such as AWS region, AWS account,
and smoke-test inputs, then generates `infra/terraform/generated.auto.tfvars`
with release-specific Terraform values: AWS region and immutable image URIs. The
plan step uses both:

```sh
terraform -chdir=infra/terraform plan -var-file=prod.tfvars -var-file=generated.auto.tfvars
```

Placeholder values such as `REPLACE_ME_*` in `prod.tfvars` or the generated
image overlay fail the plan entrypoint before Terraform changes are proposed.

ECS service `task_definition` changes are intentionally ignored by Terraform.
`terraform apply` registers the new task definitions and updates infrastructure,
but it does not roll existing running services onto the new image. For the first
deploy only, the workflow detects that the ECS services are absent and applies a
bootstrap plan with both service desired counts forced to `0`; that creates the
RDS instance, task definitions, ALB, and ECS service shells without starting app
containers. It then runs the agent database migration task, applies the normal
desired counts from `prod.tfvars`, and calls `roll_ecs_services.sh` to wait for
stability. Later deploys apply the new task definitions first, run migrations,
then roll the existing services. This keeps schema-dependent images from
starting before migrations.

`assign_public_ip=true` is intentionally kept while the existing shared
`mymemo-service` ECS subnets are public/default subnets with no NAT/VPC endpoint
egress path. It is an inherited network constraint, not the preferred production
networking pattern.

The agent internal ALB URL and `AGENT_SMOKE_BASE_URL` are intentionally
different settings:

- `agent_internal_base_url` is a Terraform output for `mymemo-service` to call
  `chat-api` inside the shared VPC:

  ```sh
  terraform -chdir=infra/terraform output -raw agent_internal_base_url
  ```

  Configure `mymemo-service` with that value and have it inject the trusted
  `X-Member-*` / `X-Partner-*` identity headers.
- `AGENT_SMOKE_BASE_URL` in `prod.env` is optional deploy verification config
  for running `scripts/deploy/prod_smoke.sh` from inside the VPC. The
  GitHub-hosted release workflow does not call this internal URL. The checked-in
  smoke identity must be allowlisted in Statsig: the script drives two real runs
  and verifies both agent-session resume and E2B workspace persistence. Set
  `AGENT_SMOKE_EXPECT_GATE_CLOSED=true` only when checking the default-deny path
  instead.

The internal ALB accepts traffic only from the configured
`mymemo_service_api_security_group_ids`. It is not exposed to the public
internet, and no Cloudflare DNS record is needed for `chat-api`.

The workflow does not require GitHub repository variables for Terraform inputs.
The only credential handoff is GitHub OIDC assuming the deploy role:

```text
arn:aws:iam::637423444544:role/mymemo-agent-github-actions-deploy
```

The deploy role itself is bootstrapped from `infra/bootstrap-iam/prod.tfvars`:

```sh
AWS_PROFILE=mymemo terraform -chdir=infra/bootstrap-iam init
AWS_PROFILE=mymemo terraform -chdir=infra/bootstrap-iam apply -var-file=prod.tfvars
```

Actual secret values stay out of git. AWS Secrets Manager is the long-term
source of truth; Terraform receives or derives only secret names, then resolves
ARNs through AWS data sources. For local one-time bootstrap, copy
`infra/deploy/prod.secrets.env.example` to `infra/deploy/prod.secrets.env` and
fill the literal values. The copied file is git-ignored and is parsed as simple
dotenv data, not executed as shell. Then run:

```sh
AWS_PROFILE=mymemo scripts/deploy/create_agent_secrets.sh
```

The script creates or updates the conventional AWS Secrets Manager entries.
`infra/deploy/prod.env` and `infra/terraform/prod.tfvars` do not contain secret
values, secret ARNs, or secret names unless an environment intentionally
overrides the Terraform convention.
The GitHub workflow does not rewrite long-lived application secret values.

## Local Validation

```sh
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
terraform -chdir=infra/bootstrap-iam init -backend=false
terraform -chdir=infra/bootstrap-iam validate
terraform -chdir=infra/ecr init -backend=false
terraform -chdir=infra/ecr validate
```

All Terraform roots require Terraform `>= 1.10.0` because the S3 backends use
native S3 lockfiles via `use_lockfile = true`.
