# One-time v1 teardown (#765)

Run `scripts/deploy/teardown_v1.sh` from the reviewed removal checkout before
its first normal Release deploy. This is a destructive operator procedure:
all v1 data is disposable, with no migration or final snapshot. Do not run
Release deploy concurrently. Do not merge as part of this procedure.

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
bridge remain managed. The separate dev artifact-bucket root is retired;
check its former state if it was deployed before deleting any dev bucket.

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
