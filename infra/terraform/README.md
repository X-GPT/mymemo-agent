# mymemo-agent Terraform

This Terraform root owns the production AWS resources for `mymemo-agent`,
including ECS, the AgentCore Runtime, and its Dispatch consumer. It consumes the
existing `mymemo-service` VPC and ECS cluster, while owning the private AgentCore
subnets and zonal fck-nat egress inside that VPC.

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

## Chat API Service Connect Migration

This first stage publishes `http://chat-api:<chat_api_port>` in an agent-owned
Cloud Map namespace. A later `mymemo-service` change must join its ECS service
to the exported namespace ARN before using the endpoint:

```sh
terraform -chdir=infra/terraform output -raw chat_api_service_connect_namespace_arn
terraform -chdir=infra/terraform output -raw chat_api_service_connect_endpoint
```

The internal ALB, smoke path, target-group alarm, and trusted-caller boundary
remain unchanged. A separate proxy ingress port admits only the same
`mymemo_service_api_security_group_ids`. The named HTTP port disables both
Service Connect request and idle timeouts for long-lived Run Live Streams, and
the task size includes proxy capacity.

Before the first release, reapply `infra/bootstrap-iam` for Cloud Map authority.
After migrations, the release rolls the named-port task revision only when the
deployed revision lacks it; the unified apply then enables Service Connect.

AWS provider `>= 6.50, < 7.0` supports the configured zero timeout values.
`appProtocol = "http"` is required for the per-request timeout setting.

## Agent-Owned Resources

- ECR repositories for `mymemo-agent-chat-api`,
  `mymemo-agent-maintenance`, `mymemo-agentcore-dispatch-publisher`, and
  `mymemo/agentcore-runtime` in the
  separate `infra/ecr` Terraform root
- dedicated RDS Postgres instance for writable agent state
- EC2 Instance Connect Endpoint and private EC2 bridge for operator access to
  the agent and KB databases
- single-node ElastiCache for Valkey replication group for temporary per-Run
  Live Streams
- private S3 bucket for durable Downloadable artifact objects
- ECS Fargate task definitions and services for chat-api, agent-maintenance,
  and the singleton AgentCore dispatch publisher
- agent DB migration task definition
- service security groups inside the shared VPC, including outbound-only
  publisher and maintenance groups that can reach the agent database but not
  the KB database
- internal agent-owned ALB, ALB security group, listeners, and chat-api target group
- Cloud Map HTTP namespace and chat-api ECS Service Connect endpoint
- IAM execution/task roles for the agent tasks
- CloudWatch log groups and baseline alarms
- encrypted AgentCore Dispatch and dead-letter queues, their fail-closed SSM
  control, and the batch-size-one consumer Lambda
- digest-pinned ARM64 AgentCore Runtime, private subnets, one pinned fck-nat
  Auto Scaling group per availability zone, workload IAM, and Dispatch alarms

The AgentCore Runtime, consumer, and dedicated Dispatch publisher share this
state because they ship on the same compatibility cycle as the ECS services and
database schema. The publisher remains a separate process and IAM boundary; a
shared Terraform state does not grant it Runtime authority.

The SQS mapping stays enabled while the SSM value is an operator-owned,
fail-closed control. Terraform creates the parameter with `disabled`, ignores
later value drift, and preserves the exact live value through routine releases.

The artifact bucket blocks all public access, enforces bucket-owner ownership,
uses SSE-S3 encryption, denies non-TLS requests, has versioning disabled, and
defines no CORS policy. Only the `chat-api` application role can read an
ownership-checked current object for presigning; it cannot write, delete, or
list bucket contents. Publication, retention, cleanup, and downstream handoff
procedures are documented in the
[Downloadable artifact runbook](../../docs/runbooks/downloadable-artifacts.md).

## Secrets

This Terraform root always creates a dedicated RDS Postgres instance for
`AGENT_DATABASE_URL`. RDS manages the master password in Secrets Manager; ECS
receives `AGENT_DATABASE_URL` without a password plus `DB_PASSWORD` from the
RDS-managed secret. This is the writable agent state database for conversations,
leases, run state, and migrations. It is separate from the read-only KB database
URL used by the AgentCore Runtime.

Terraform also generates the Live Stream cache authentication token and stores
the complete `rediss://` connection URL in the Terraform-managed
`<name_prefix>-<environment>-REDIS_URL` Secrets Manager secret. ECS injects that
secret into `chat-api`; the AgentCore Runtime resolves it from Secrets Manager.
It is not added to maintenance, the migration task, or any E2B sandbox, and
neither the credential nor the complete URL is exposed as a Terraform output.

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

The AgentCore dispatch publisher receives only `AGENT_DATABASE_URL`, the RDS
password secret, its SQS queue URL, and its fail-closed SSM gate name. Its task
role can read that parameter and publish to the exact encrypted queue. Its
separate execution role can read only the RDS password secret; it receives no
KB, OpenRouter, E2B, artifact, or Redis credentials.

## Valkey Live Stream Infrastructure

The ElastiCache for Valkey cache is an ephemeral Redis-compatible pub/sub relay
for AG-UI Live Streams, not a storage or permanent-history authority. Producers
keep active-Run backlogs in Runtime memory; the cache holds no per-Run keys. It
is a single `cache.t4g.micro` node with no replicas, Multi-AZ failover,
automatic snapshots, final snapshot, or backup retention. The cache is
reachable on its TLS port only from a dedicated client security group attached
to `chat-api` and the AgentCore Runtime; the migration task does not receive
that group.
ElastiCache does not receive a public address or a CIDR-based ingress rule.
Authentication and in-transit encryption are mandatory.

Production upgrades the existing Redis OSS 7.1 replication group to Valkey 7.2
in place. The Terraform resource address, replication-group identifier,
`cache.t4g.micro` node type, primary endpoint DNS name, TLS port, AUTH token,
and `rediss://` secret contract remain stable. AWS may change the node's
underlying IP during the cross-engine upgrade, so clients must continue using
the endpoint DNS name. Because the relay is deliberately non-durable, the
upgrade does not add snapshots or persistence; brief publication interruption
degrades active Live Streams to permanent Postgres history.

Before the first cache plan in an existing environment, reapply
`infra/bootstrap-iam` with the admin profile as shown below. That updates the
GitHub Actions deploy role with the ElastiCache permissions used by this root.

`REDIS_URL` is required at chat-api and AgentCore Runtime startup and must be an
authenticated `rediss://` URL. Runtime cache availability remains outside
readiness: an outage degrades live delivery but does not make either service
unhealthy, and permanent Conversation history and Outcomes remain in Postgres.

Live Stream telemetry is converted into a CloudWatch namespace using bounded
operation/result dimensions and reason classifications. The alarms identify
AgentCore Runtime production failures, chat-api recovery responses, and capacity
exhaustion without feeding service health. Production must set
`alarm_action_arns` to an SNS topic with a confirmed incident subscription. See
[`docs/runbooks/live-stream.md`](../../docs/runbooks/live-stream.md) for Live
Stream relay diagnosis.

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
with release-specific Terraform values: AWS region and the three immutable ECS
image URIs. The Runtime repository URL comes from the separately applied ECR
root; its digest and the consumer package path are supplied through Terraform
environment variables by the same workflow. The plan step uses both:

```sh
terraform -chdir=infra/terraform plan -var-file=prod.tfvars -var-file=generated.auto.tfvars
```

Placeholder values such as `REPLACE_ME_*` in `prod.tfvars` or the generated
image overlay fail the plan entrypoint before Terraform changes are proposed.

### AgentCore Runtime repository state handoff

The Runtime repository predates its ownership by `infra/ecr`. During the first
authorized release containing this handoff, the ECR step checks whether
`aws_ecr_repository.agentcore_runtime` is already in `ecr-prod.tfstate`. If it
is absent but `mymemo/agentcore-runtime` exists in AWS, the step imports that
repository before the normal ECR apply. A repository absent from both AWS and
state is created normally for a clean environment.

The later unified production apply uses a Terraform `removed` block with
`destroy = false` to forget the historical
`aws_ecr_repository.production_runtime` address. An interrupted release may
temporarily leave the repository recorded in both states, but never deletes or
recreates it; rerun the same reviewed release to finish the handoff. Do not
manually remove or import either state address during that recovery.

After the release succeeds, verify the single owner without reading image
contents:

```sh
AWS_PROFILE=mymemo terraform -chdir=infra/ecr state show aws_ecr_repository.agentcore_runtime
if AWS_PROFILE=mymemo terraform -chdir=infra/terraform state list \
  | rg -q '^aws_ecr_repository\.production_runtime$'; then
  echo "Production state still records the Runtime repository" >&2
  exit 1
fi
```

The first command must succeed and the guard must exit without printing an
error.

ECS service `task_definition` changes are intentionally ignored by Terraform.
For an ordinary release, the workflow first applies a saved, targeted plan
containing the migration task definition and its Terraform-declared IAM
prerequisites. It runs that migration, then re-plans and applies the complete
state so the consumer Lambda, AgentCore Runtime, publisher task definition, and
other ECS task definitions all move together after the compatible schema
exists. Finally it rolls the ECS services. The target is an ordering mechanism
inside one release, not a second state or a manual pause.

For the one-time empty ECS bootstrap, all service desired counts are
forced to zero until the migration completes. Because that bootstrap may create
or update the consumer before the schema exists, it requires the SSM Dispatch
control to be `disabled`. Routine releases accept and preserve either live
value.

`assign_public_ip=true` remains an inherited constraint for chat-api and
agent-maintenance in the shared public/default ECS subnets.
The Dispatch publisher
runs without a public address in the AgentCore private subnets and shares their
zonal fck-nat egress.

The fck-nat Terraform module is pinned to `1.5.0`, and production pins the
reviewed official ARM64 AMI ID instead of resolving the latest publisher image.
Each availability zone gets a one-instance Auto Scaling group, static internal
ENI, new EIP, encrypted root disk, CloudWatch agent metrics, and an alarm when
the group has no in-service instance. A replacement loses existing connections
and can interrupt egress for that zone for several minutes.

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
  smoke identity must be allowlisted in Statsig: the default `core` suite drives
  three real Runs, verifies Agent-session resume and Workspace persistence,
  recovers each terminal Run through Conversation history, and checks
  Downloadable-artifact listing plus signed attachment delivery. Set
  `AGENT_SMOKE_EXPECT_GATE_CLOSED=true` only when checking the default-deny path
  instead.

The internal ALB and Service Connect endpoint accept traffic only from the
configured `mymemo_service_api_security_group_ids`. Neither is exposed to the
public internet, and no Cloudflare DNS record is needed for `chat-api`.

## Operator Database Access

The EC2 Instance Connect Endpoint provides IAM-authorized SSH access to a
private Amazon Linux bridge with no public IP. The endpoint security group can
reach only port 22 on that bridge, and the bridge can reach only port 5432 on
the agent and KB database security groups. PostgreSQL is accessed through SSH
local forwarding; EICE does not tunnel directly to database ports. Client IP
preservation is disabled, while CloudTrail still records the caller and SSH
tunnel request.

The commands below require AWS CLI v2, `jq`, and `psql`. Run them from the
repository root with the `mymemo` profile. Keep each SSH process running while
using `psql` from a second terminal.

```sh
export AWS_PROFILE=mymemo
export AWS_REGION=us-west-2
EICE_ID="$(terraform -chdir=infra/terraform output -raw database_access_endpoint_id)"
BRIDGE_INSTANCE_ID="$(terraform -chdir=infra/terraform output -raw database_access_bridge_instance_id)"
```

To connect to the agent database, start the tunnel on local port 15432:

```sh
AGENT_DB_HOST="$(terraform -chdir=infra/terraform output -raw agent_database_endpoint)"

aws ec2-instance-connect ssh \
  --instance-id "$BRIDGE_INSTANCE_ID" \
  --os-user ec2-user \
  --connection-type eice \
  --eice-options "endpointId=$EICE_ID,maxTunnelDuration=3600" \
  --local-forwarding "15432:$AGENT_DB_HOST:5432"
```

Then connect from a second terminal. The RDS-managed password is passed to
`psql` only for the lifetime of the command:

```sh
export AWS_PROFILE=mymemo
export AWS_REGION=us-west-2
AGENT_DB_SECRET_ARN="$(terraform -chdir=infra/terraform output -raw agent_database_password_secret_arn)"
AGENT_DB_SECRET="$(aws secretsmanager get-secret-value \
  --secret-id "$AGENT_DB_SECRET_ARN" \
  --query SecretString \
  --output text)"

PGPASSWORD="$(printf '%s' "$AGENT_DB_SECRET" | jq -r .password)" \
  psql "host=127.0.0.1 port=15432 dbname=mymemo_agent user=mymemo_agent sslmode=require"

unset AGENT_DB_SECRET AGENT_DB_SECRET_ARN
```

To connect to the KB database, start a separate tunnel on local port 25432:

```sh
export AWS_PROFILE=mymemo
export AWS_REGION=us-west-2
EICE_ID="$(terraform -chdir=infra/terraform output -raw database_access_endpoint_id)"
BRIDGE_INSTANCE_ID="$(terraform -chdir=infra/terraform output -raw database_access_bridge_instance_id)"
KB_DB_HOST="$(aws rds describe-db-instances \
  --db-instance-identifier mymemo-staging-pg \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text)"

aws ec2-instance-connect ssh \
  --instance-id "$BRIDGE_INSTANCE_ID" \
  --os-user ec2-user \
  --connection-type eice \
  --eice-options "endpointId=$EICE_ID,maxTunnelDuration=3600" \
  --local-forwarding "25432:$KB_DB_HOST:5432"
```

Then read the existing KB connection URL and rebuild only its authority host
and port for the local tunnel. This preserves the encoded credentials, database
name, and query parameters without depending on whether the original URL
explicitly includes port 5432:

```sh
export AWS_PROFILE=mymemo
export AWS_REGION=us-west-2
KB_DATABASE_URL="$(aws secretsmanager get-secret-value \
  --secret-id mymemo-agent-prod-KB_DATABASE_URL \
  --query SecretString \
  --output text)"
KB_DATABASE_URL_PREFIX="${KB_DATABASE_URL%%@*}@"
KB_DATABASE_URL_AFTER_AUTHORITY="${KB_DATABASE_URL#*@}"
KB_DATABASE_URL_PATH="/${KB_DATABASE_URL_AFTER_AUTHORITY#*/}"
KB_TUNNEL_DATABASE_URL="${KB_DATABASE_URL_PREFIX}127.0.0.1:25432${KB_DATABASE_URL_PATH}"

PGSSLMODE=require psql "$KB_TUNNEL_DATABASE_URL"

unset KB_DATABASE_URL KB_DATABASE_URL_PREFIX KB_DATABASE_URL_AFTER_AUTHORITY
unset KB_DATABASE_URL_PATH KB_TUNNEL_DATABASE_URL
```

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
