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
- ECS Fargate task definitions and services for chat-api and agent-worker
- agent DB migration task definition
- service security group inside the shared VPC
- public agent-owned ALB, ALB security group, listeners, and chat-api target group
- IAM execution/task roles for the agent tasks
- CloudWatch log groups and baseline alarms

## Secrets

This Terraform root always creates a dedicated RDS Postgres instance for
`AGENT_DATABASE_URL`. RDS manages the master password in Secrets Manager; ECS
receives `AGENT_DATABASE_URL` without a password plus `DB_PASSWORD` from the
RDS-managed secret. This is the writable agent state database for conversations,
leases, run state, and migrations. It is separate from the read-only KB database
URL used by `agent-worker`.

Other secret values are not committed. Terraform resolves conventional Secrets
Manager names to ARNs at plan/apply time, and ECS task definitions consume those
resolved ARNs:

- `KB_DATABASE_URL`
- `LLM_TOKEN_SECRET`
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
with release-specific Terraform values: AWS region, immutable image URIs, and
the required `gateway_public_url` workflow input. The plan step uses both:

```sh
terraform -chdir=infra/terraform plan -var-file=prod.tfvars -var-file=generated.auto.tfvars
```

Placeholder values such as `REPLACE_ME_*` in `prod.tfvars` or the generated
image overlay fail the plan entrypoint before Terraform changes are proposed.
`gateway_public_url` is intentionally not checked in as a placeholder; provide
the real gateway base URL when dispatching the release workflow.

ECS service `task_definition` changes are intentionally ignored by Terraform.
`terraform apply` registers the new task definitions and updates infrastructure,
but it does not roll running services onto the new image. The release workflow
runs the agent database migration task first, then `roll_ecs_services.sh`
updates each service to the Terraform-created task definition and waits for
stability. This keeps schema-dependent images from starting before migrations.

`assign_public_ip=true` is intentionally kept while the existing shared
`mymemo-service` ECS subnets are public/default subnets with no NAT/VPC endpoint
egress path. It is an inherited network constraint, not the preferred production
networking pattern.

`gateway_public_url` and `AGENT_SMOKE_BASE_URL` are intentionally different
settings:

- `gateway_public_url` is runtime application config provided as a required
  release workflow input. `chat-api` passes it to E2B sandboxes so the agent can
  call the gateway for LLM and document access. This is not the agent-owned ALB
  URL unless that ALB is actually routing the gateway service.
- `AGENT_SMOKE_BASE_URL` in `prod.env` is deploy verification config. The GitHub Actions
  runner calls this base URL after rollout to verify `chat-api` responds at
  `/v1/conversations`. It should point at the agent-owned ALB DNS name or a
  custom domain alias for that ALB. It is not consumed by the running ECS tasks.

The production config reuses the existing `*.mymemo.ai` ACM certificate in
`us-west-2`, matching the `mymemo-service` pattern. DNS remains outside
Terraform: create a Cloudflare CNAME such as `agent-api.mymemo.ai` pointing at
`terraform -chdir=infra/terraform output -raw agent_alb_dns_name`, then set
`AGENT_SMOKE_BASE_URL=https://agent-api.mymemo.ai`.

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
