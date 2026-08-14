#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

ecs_cluster_arn="$(
  terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn
)"

chat_api_service_name="$(
  terraform -chdir=infra/terraform output -raw chat_api_service_name
)"

agent_worker_service_name="$(
  terraform -chdir=infra/terraform output -raw agent_worker_service_name
)"

chat_api_task_definition="$(
  terraform -chdir=infra/terraform output -raw chat_api_task_definition_arn
)"

agent_worker_task_definition="${AGENT_WORKER_TASK_DEFINITION_ARN:-$(
  terraform -chdir=infra/terraform output -raw agent_worker_task_definition_arn
)}"

candidate_lane_aware="$(
  aws ecs describe-task-definition \
    --task-definition "$agent_worker_task_definition" \
    --query 'taskDefinition.containerDefinitions[?name==`agent-worker`] | [0].environment[?name==`MYMEMO_FARGATE_EXECUTION_LANE_AWARE`] | [0].value' \
    --output text
)"
if [[ "$candidate_lane_aware" != "true" ]]; then
  candidate_lane_aware="false"
fi

"$script_dir/run_execution_lane_deployment_assertion.sh" \
  prepare-fargate-deployment \
  "$candidate_lane_aware"

aws ecs update-service \
  --cluster "$ecs_cluster_arn" \
  --service "$chat_api_service_name" \
  --task-definition "$chat_api_task_definition" \
  --force-new-deployment \
  >/dev/null

aws ecs update-service \
  --cluster "$ecs_cluster_arn" \
  --service "$agent_worker_service_name" \
  --task-definition "$agent_worker_task_definition" \
  --force-new-deployment \
  >/dev/null

aws ecs wait services-stable \
  --cluster "$ecs_cluster_arn" \
  --services "$chat_api_service_name" "$agent_worker_service_name"

expected_task_definition="$agent_worker_task_definition"
service_task_definition="$(
  aws ecs describe-services \
    --cluster "$ecs_cluster_arn" \
    --services "$agent_worker_service_name" \
    --query 'services[0].taskDefinition' \
    --output text
)"
running_task_arns="$(
  aws ecs list-tasks \
    --cluster "$ecs_cluster_arn" \
    --service-name "$agent_worker_service_name" \
    --desired-status RUNNING \
    --query 'taskArns' \
    --output text
)"

if [[ "$service_task_definition" != "$expected_task_definition" ]]; then
  echo "Fargate deployment is not fully execution-lane-aware: service uses $service_task_definition, expected $expected_task_definition" >&2
  exit 1
fi

if [[ -n "$running_task_arns" && "$running_task_arns" != "None" ]]; then
  running_task_definitions="$(
    # Intentional word splitting: AWS emits one tab-separated ARN per task.
    # shellcheck disable=SC2086
    aws ecs describe-tasks \
      --cluster "$ecs_cluster_arn" \
      --tasks $running_task_arns \
      --query 'tasks[].taskDefinitionArn' \
      --output text
  )"
  for task_definition in $running_task_definitions; do
    if [[ "$task_definition" != "$expected_task_definition" ]]; then
      echo "Fargate deployment is not fully execution-lane-aware: running task uses $task_definition, expected $expected_task_definition" >&2
      exit 1
    fi
  done
fi

if [[ "$candidate_lane_aware" == "true" ]]; then
  "$script_dir/run_execution_lane_deployment_assertion.sh" \
    mark-fargate-lane-aware
fi
