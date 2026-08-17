#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

action="${1:-}"
candidate_runtime_aware="${2:-false}"
case "$action" in
  prepare-fargate-deployment)
    if [[ "$candidate_runtime_aware" != "true" && "$candidate_runtime_aware" != "false" ]]; then
      echo "Candidate runtime-awareness must be exactly true or false" >&2
      exit 1
    fi
    ;;
  mark-fargate-runtime-aware)
    candidate_runtime_aware="true"
    ;;
  *)
    echo "Usage: $0 prepare-fargate-deployment <true|false> | mark-fargate-runtime-aware" >&2
    exit 1
    ;;
esac

task_definition="${EXECUTION_RUNTIME_ASSERTION_TASK_DEFINITION_ARN:-$(
  terraform -chdir=infra/terraform output -raw agent_migration_task_definition_arn
)}"
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

overrides="$(bun -e '
  const [action, candidateRuntimeAware] = process.argv.slice(1);
  console.log(JSON.stringify({
    containerOverrides: [{
      name: "agent-migration",
      command: ["db:execution-runtime-deployment"],
      environment: [
        { name: "EXECUTION_RUNTIME_DEPLOYMENT_ACTION", value: action },
        { name: "CANDIDATE_FARGATE_RUNTIME_AWARE", value: candidateRuntimeAware },
      ],
    }],
  }));
' "$action" "$candidate_runtime_aware")"

task_arn="$(
  aws ecs run-task \
    --cluster "$ecs_cluster_arn" \
    --launch-type FARGATE \
    --task-definition "$task_definition" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnet_ids],securityGroups=[$service_security_group_id],assignPublicIp=$assign_public_ip}" \
    --overrides "$overrides" \
    --query 'tasks[0].taskArn' \
    --output text
)"

if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "Failed to start execution-runtime deployment assertion task" >&2
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
  echo "Execution-runtime deployment assertion failed with exit code $exit_code: $stopped_reason" >&2
  exit 1
fi
