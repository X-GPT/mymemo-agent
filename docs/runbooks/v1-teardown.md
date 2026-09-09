# One-time v1 teardown (#765)

For an untouched v1 deployment, run `scripts/deploy/teardown_v1.sh` from the reviewed removal checkout before
its first normal Release deploy. This is a destructive operator procedure:
all v1 data is disposable, with no migration or final snapshot. Do not run
Release deploy concurrently. Do not merge as part of this procedure.

## Current production: resume after the partial teardown

The 2026-09-08 production apply removed v1 except for the `services` and
`live_redis_clients` security groups. Do not restart the one-shot wizard.
The old AgentCore ENIs were verified absent on 2026-09-09, so the temporary
`v1-security-groups.tf` definitions have now been removed. Apply a fresh plan
using the deployed front ZIP and Runtime digest; require only the two remaining
security-group deletions with all surviving resources unchanged. Keep their
addresses in `scripts/deploy/v1-resources.txt` for the final absence check.

AgentCore can retain shared ENIs for up to eight hours after Runtime deletion
([AWS documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html)).
Do not detach service ENIs or alter the surviving Runtime to force cleanup.
Complete the live inventory and Turn/KB checks below before closing #765.
Next-bill confirmation remains in #767.

The wizard uses the `mymemo` AWS profile, checks account `637423444544`, and
uses us-west-2. It needs Git history containing `6338550`, Terraform, AWS CLI,
Python 3, jq and curl. No secret values are requested or printed. State and
plans go to a private temporary directory shown by the wizard; retain that
directory securely until verification completes, then delete it.

## Stages

1. Capture production state and the exact deployed front ZIP and Runtime
   digest from the live API (stored outputs may be stale). A temporary override
   ignores only the ZIP filename path; its content hash remains checked. Copy the pre-removal Terraform revision and the reviewed removal
   configuration into separate temporary directories sharing the same backend.
2. Strip KMS `prevent_destroy`, set RDS `deletion_protection = false` and
   `skip_final_snapshot = true`. Plan only the RDS/KMS dependency graph. The
   guard allows only the two RDS attribute changes. Review and confirm apply;
   verify live RDS deletion protection is false before continuing.
3. Plan with the removal definitions. The guard rejects creates, replacements,
   updates, or deletions outside `scripts/deploy/v1-resources.txt`. New-stack
   resources must all be no-op. Review and confirm apply. Terraform schedules
   Redis-secret deletion; RDS owns its managed password secret lifecycle.
   The wizard separately schedules E2B-secret deletion with seven-day recovery
   because E2B was only a Terraform data source.
4. Verify the state, live inventory, secrets and a real Turn below. Save the
   evidence before marking operator acceptance complete.

A failed plan guard is a stop: investigate drift and do not bypass it. A
failed apply may have partially succeeded. Inspect the retained plans/state
and live AWS before continuing manually from the failed stage; do not blindly
restart the wizard after resource or output deletion. The wizard is one-shot.

The new DynamoDB/S3 test data is deliberately left alone (the issue calls its
wipe optional). The legacy artifact bucket, ECR, bootstrap IAM and KB operator
bridge remain managed. The separate dev artifact-bucket root is retired; destroy its existing state
with the procedure below.

## Live removal checks

Use `aws --profile mymemo --region us-west-2` for each command. Inspect both
`mymemo-agent-prod-*` and `mymemo-agent-agentcore-prod-*` names. An AWS access or
network error is not evidence of absence.

- `ecs list-services --cluster <shared cluster from before.json>`: no chat-api,
  maintenance or dispatch-publisher service. Confirm any draining service is
  INACTIVE with zero running tasks using `ecs describe-services`.
- `elbv2 describe-load-balancers`: no `mymemo-agent-prod-alb`.
- `rds describe-db-instances`: no `mymemo-agent-prod-db`.
- `elasticache describe-replication-groups`: no v1 live replication group.
- `sqs list-queues --queue-name-prefix mymemo-agent-agentcore-prod`: no dispatch
  queue or DLQ.
- `kms list-aliases`: no `alias/mymemo-agent-agentcore-prod`. The key itself is
  scheduled for deletion according to its KMS waiting period.
- `bedrock-agentcore-control list-agent-runtimes`: no
  `mymemo_agentcore_prod-*`; `mymemo_agent_prod-*` must remain READY.
- `lambda list-functions`: no `mymemo-agent-agentcore-prod-consumer`.
- `secretsmanager describe-secret --secret-id <recorded ARN>`: E2B and Redis
  have `DeletedDate`. The RDS-managed password may already be absent after DB
  deletion; confirm ResourceNotFound rather than swallowing another error.

## Unmanaged leftovers and the former dev root

Before the final Turn check, complete the #732 fates-ledger cleanup outside
production Terraform. Read-only inventory on 2026-09-08 found these subnets:

| Subnet | CIDR | Name prefix |
| --- | --- | --- |
| `subnet-0ff70ed49ea0c3845` | `172.31.64.0/24` | `mymemo-agentcore-prototype-20260813095724` |
| `subnet-0fb6cdacd19f98ee8` | `172.31.65.0/24` | `mymemo-agentcore-prototype-20260813095724` |
| `subnet-0ab286f6d4b8b9f61` | `172.31.70.0/24` | `mymemo-agentcore-dispatch-20260813122403` |
| `subnet-0fca0efa90d78ab98` | `172.31.71.0/24` | `mymemo-agentcore-dispatch-20260813122403` |

Re-run `ec2 describe-subnets` with the two name-prefix tag filters. Confirm
these exact IDs are outside all relevant Terraform state before deletion:
production `before.json`, the former `agentcore-canary-prod.tfstate`, dev,
and shared-service state. The old canary state currently contains only data
sources. Never remove the surviving Runtime's `172.31.80/24` and `81/24`
subnets or the shared-service public subnets.

For each verified retired subnet, inspect `ec2 describe-network-interfaces
--filters Name=subnet-id,Values=<id>` and its route-table associations.
The two dispatch subnets currently have four available Lambda VPC ENIs whose
description ends in `20260813122403-control`. Check requester-managed status
and the owning Lambda's VPC configuration; retire only the confirmed old
prototype/dispatch owner and let AWS release service-managed ENIs. Do not
force-detach an ENI or alter a current service to unblock deletion. If ownership
is unclear, stop and resolve it. Once no interfaces remain, run
`aws --profile mymemo --region us-west-2 ec2 delete-subnet --subnet-id <verified-id>`
and re-list to prove absence.

`secretsmanager list-secrets --include-planned-deletion --filters
Key=name,Values=GATEWAY_TOKEN_SECRET` returned no entries in this account/region
on 2026-09-08. Recheck during teardown. If present, verify its exact ARN belongs
to the retired gateway and is absent from surviving configuration, then use
`secretsmanager delete-secret --secret-id <verified-arn>
--recovery-window-in-days 7`. Record DeletedDate; never retrieve the value.

The former `mymemo-agent/dev.tfstate` still manages only the
`mymemo-agent-local-artifacts` bucket and its seven associated settings.
Restore its pinned configuration to a private directory and destroy through
that backend (do not merely remove its state):

```sh
umask 077
dev_cleanup="$(mktemp -d)"
git archive 6338550 infra/dev | tar -x -C "$dev_cleanup"
AWS_PROFILE=mymemo terraform -chdir="$dev_cleanup/infra/dev" init -lockfile=readonly
AWS_PROFILE=mymemo terraform -chdir="$dev_cleanup/infra/dev" plan -destroy -out=delete.tfplan
# Verify only mymemo-agent-local-artifacts and its settings are deleted.
# If nonempty, inspect and explicitly discard this bucket's contents first;
# do not touch the production workspace or artifact buckets.
AWS_PROFILE=mymemo terraform -chdir="$dev_cleanup/infra/dev" apply delete.tfplan
```

Record the live subnet absence, conditional secret deletion/absence and empty
dev managed state with the production teardown evidence. These read-only
inventory results are not evidence that deletion has already happened.

## New-stack acceptance

Start the signing proxy from [the front runbook](agent-front.md), using an
identity the production Statsig gate already permits. Create a Conversation,
then send “Use ListDocuments to list my available documents, then reply
TEARDOWN-765-OK.” through its Function URL-backed `/messages` route. Require
stream completion, a successful ListDocuments result (an empty inventory is
valid), and a completed reply returned by GET messages. This checks both a
real Turn and Runtime-to-KB reachability. Record the Conversation/Turn ids and
UTC timestamp, then delete only that smoke Conversation.

Compare Lambda `get-function-configuration` CodeSha256 and Runtime
`get-agent-runtime` container digest with the before evidence. They must be
unchanged. Run `inspect_agentcore.sh` with `AWS_PROFILE=mymemo`,
`AWS_REGION=us-west-2` and `EXPECTED_RUNTIME_IMAGE_DIGEST` set to the recorded
new Runtime digest from the production checkout after init/apply.

Confirm approximately USD 80/month removed on the next bill (Fargate ~36,
RDS ~14, cache ~12, ALB ~17, KMS ~1). Billing evidence is a later operator check,
not something a Terraform plan proves.

## PR verification — 2026-09-08

Read-only production plan using the live Runtime image
`sha256:068197fe1247a46dc97cdc4d7cf9ffc1f57862ef3235bd68581ace9a2ee97684`
and downloaded deployed front ZIP: **90 deletes, 0 creates, 0 updates**;
97 managed resources are no-op. The filename-only temporary override above
was used. The plan guard passed. No Terraform apply was performed.

Remaining workspace suite passed; all 54 front tests also passed with
DynamoDB Local and local S3. Both app TypeScript checks, front packaging,
Terraform validate/fmt, shell syntax and the plan guard regression check passed.
Live removal, post-removal Turn/KB evidence and the next bill remain operator
acceptance steps; pre-removal tests do not claim those outcomes.
