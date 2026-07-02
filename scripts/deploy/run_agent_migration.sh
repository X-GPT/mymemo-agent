#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

task_definition="$(
  terraform -chdir=infra/terraform output -raw agent_migration_task_definition_arn
)"

ecs_cluster_arn="$(
  terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn
)"

subnet_ids="$(
  terraform -chdir=infra/terraform output -json shared_ecs_subnet_ids \
    | bun -e 'const chunks=[]; for await (const chunk of Bun.stdin.stream()) chunks.push(chunk); const ids=JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); console.log(ids.join(","));'
)"

service_security_group_id="$(
  terraform -chdir=infra/terraform output -raw service_security_group_id
)"

terraform_assign_public_ip="$(
  terraform -chdir=infra/terraform output -raw assign_public_ip
)"

assign_public_ip="DISABLED"
if [[ "$terraform_assign_public_ip" == "true" ]]; then
  assign_public_ip="ENABLED"
fi

echo "Running agent DB migration task: $task_definition"

task_arn="$(
  aws ecs run-task \
    --cluster "$ecs_cluster_arn" \
    --launch-type FARGATE \
    --task-definition "$task_definition" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnet_ids],securityGroups=[$service_security_group_id],assignPublicIp=$assign_public_ip}" \
    --query 'tasks[0].taskArn' \
    --output text
)"

if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "Failed to start agent migration task" >&2
  exit 1
fi

aws ecs wait tasks-stopped \
  --cluster "$ecs_cluster_arn" \
  --tasks "$task_arn"

exit_code="$(
  aws ecs describe-tasks \
    --cluster "$ecs_cluster_arn" \
    --tasks "$task_arn" \
    --query 'tasks[0].containers[?name==`agent-migration`].exitCode | [0]' \
    --output text
)"

stopped_reason="$(
  aws ecs describe-tasks \
    --cluster "$ecs_cluster_arn" \
    --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' \
    --output text
)"

if [[ "$exit_code" != "0" ]]; then
  echo "Agent migration failed with exit code $exit_code: $stopped_reason" >&2
  exit 1
fi

echo "Agent migration completed successfully."
