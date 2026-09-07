# Simplified chat Runtime on AWS

Issue #750 deploys `apps/agent-runtime` beside v1 in us-west-2. It still has
#736's no-tools query loop; sandbox tools, KB reads and transcript persistence
arrive in #738–#740. The bucket and SANDBOX interpreter prerequisites live in
`workspace-bucket.tf` and `code-interpreter.tf`; #742 should reuse them.

## Build and register

The PR image job builds linux/arm64 and runs the pinned SDK against the fake
model server, including bootstrap checks. `release-deploy.yml` builds the same
image, verifies it, pushes to `mymemo/agent-runtime`, and passes the resolved
`sha256` digest as `TF_VAR_agent_runtime_image_digest` to both Terraform jobs.
The existing v1 image, digest and rollout steps remain independent.

For a local operator build (all local AWS commands use profile `mymemo`):

```sh
bun install --frozen-lockfile
docker build --platform linux/arm64 -f apps/agent-runtime/Dockerfile \
  -t mymemo-agent-runtime:verified .
docker run --rm --platform linux/arm64 --entrypoint bun \
  mymemo-agent-runtime:verified test --timeout=60000 src

AWS_PROFILE=mymemo terraform -chdir=infra/ecr init
AWS_PROFILE=mymemo terraform -chdir=infra/ecr plan -var=aws_region=us-west-2 \
  -target=aws_ecr_repository.agent_runtime -out=runtime-ecr.tfplan
# Inspect the plan before applying it.
AWS_PROFILE=mymemo terraform -chdir=infra/ecr apply runtime-ecr.tfplan
repository_uri=$(AWS_PROFILE=mymemo terraform -chdir=infra/ecr output -raw agent_runtime_ecr_repository_url)
registry=${repository_uri%%/*}
aws --profile mymemo ecr get-login-password --region us-west-2 |
  docker login --username AWS --password-stdin "$registry"
image_tag="issue-750-$(git rev-parse --short HEAD)-$(date +%s)"
docker tag mymemo-agent-runtime:verified "$repository_uri:$image_tag"
docker push "$repository_uri:$image_tag"
export TF_VAR_agent_runtime_image_digest=$(aws --profile mymemo ecr describe-images \
  --region us-west-2 --repository-name mymemo/agent-runtime \
  --image-ids imageTag="$image_tag" --query 'imageDetails[0].imageDigest' --output text)
```

Normal registration uses the manually authorized release workflow on `main`.
For the pre-merge demo, use the existing production tfvars and unchanged v1
image/package inputs, save and inspect a targeted plan for
`aws_cloudwatch_log_group.agent_runtime`, all `workspace` bucket resources,
`aws_s3_bucket_policy.workspace_tls_only`, and
`aws_security_group_rule.agent_services_to_kb_db`. The Runtime target's
Terraform dependencies include its role, interpreter, and private subnets.
Apply only that inspected plan. Do not apply unrelated changes from other
open implementation tickets. Keep the new resources in the shared Terraform
state so the next release updates them in place.

Terraform owns the new Runtime, role and retained log group. Its only security
group is `runtime`; it shares the existing private subnets and fck-nat egress.
The KB ingress now references that group (v1 already carries it). Sessions idle
out at 900 seconds and have a maximum lifetime of 3600 seconds.

Secrets remain ARNs in Terraform and the Runtime environment. Bootstrap reads
the OpenRouter secret's `AWSCURRENT` string before listening; failures stop
startup. The image carries the digest-pinned RDS CA bundle. The role grants
only ECR pull, logs, tracing, the OpenRouter/KB secrets, Invoke/Get on the
specific interpreter, and Get/Put on `_transcripts/*`. It cannot start/stop
sandbox sessions, access DynamoDB, or read/write the other bucket prefixes.

## Invoke and prove the budget

After the Runtime and its `DEFAULT` endpoint are ready:

```sh
runtime_arn=$(AWS_PROFILE=mymemo terraform -chdir=infra/terraform output -raw simplified_agent_runtime_arn)
work_dir=$(mktemp -d)
turn_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
jq -n --arg turn "$turn_id" --argjson now "$(date +%s)000" '{
  conversationId: $turn, turnId: $turn, seq: 1, requestId: $turn,
  userId: "runtime-smoke", scope: {kind: "general"},
  text: "Reply with exactly: runtime smoke ok", startedAt: $now,
  budgetUntil: ($now + 720000), sandboxSessionId: "unused-no-tools"
}' > "$work_dir/payload.json"
aws --profile mymemo bedrock-agentcore invoke-agent-runtime --region us-west-2 \
  --agent-runtime-arn "$runtime_arn" --qualifier DEFAULT \
  --runtime-session-id "$turn_id" --content-type application/json \
  --accept application/x-ndjson --payload "fileb://$work_dir/payload.json" \
  "$work_dir/normal.ndjson"
cat "$work_dir/normal.ndjson"
```

Expect raw `system/init`, `stream_event`, `assistant`, and a successful SDK
`result` containing `runtime smoke ok`. There is no UIMessage conversion here.

Repeat with a fresh Runtime session and both timestamps in the past (the
payload must still satisfy `startedAt < budgetUntil <= startedAt + 720000`):

```sh
turn_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
jq --arg turn "$turn_id" --argjson now "$(date +%s)000" \
  '.turnId = $turn | .requestId = $turn | .startedAt = ($now - 720000) | .budgetUntil = ($now - 1)' \
  "$work_dir/payload.json" > "$work_dir/expired.json"
aws --profile mymemo bedrock-agentcore invoke-agent-runtime --region us-west-2 \
  --agent-runtime-arn "$runtime_arn" --qualifier DEFAULT \
  --runtime-session-id "$turn_id" --content-type application/json \
  --accept application/x-ndjson --payload "fileb://$work_dir/expired.json" \
  "$work_dir/expired.ndjson"
cat "$work_dir/expired.ndjson"
```

The query deadline is `budgetUntil - 120000`; the last two minutes are cleanup
grace. A wholly expired payload also immediately exhausts that grace, so the
SDK may throw before initialization and emit a terminal `mymemo.error` abort
instead of an SDK result. To observe the graceful SDK error result separately,
set `startedAt = now - 600000` and `budgetUntil = now + 120000`.
Record the image digest, Runtime version, event types and terminal outcomes
on the PR; never record model keys or database URLs.
