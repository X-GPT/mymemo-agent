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

agent_worker_task_definition="$(
  terraform -chdir=infra/terraform output -raw agent_worker_task_definition_arn
)"

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
