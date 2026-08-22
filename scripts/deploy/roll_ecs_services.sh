#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

ecs_cluster_arn="$(terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn)"
service_names=(
  "$(terraform -chdir=infra/terraform output -raw chat_api_service_name)"
  "$(terraform -chdir=infra/terraform output -raw agent_maintenance_service_name)"
  "$(terraform -chdir=infra/terraform output -raw agentcore_dispatch_publisher_service_name)"
)
task_definitions=(
  "$(terraform -chdir=infra/terraform output -raw chat_api_task_definition_arn)"
  "$(terraform -chdir=infra/terraform output -raw agent_maintenance_task_definition_arn)"
  "$(terraform -chdir=infra/terraform output -raw agentcore_dispatch_publisher_task_definition_arn)"
)

for index in "${!service_names[@]}"; do
  aws ecs update-service \
    --cluster "$ecs_cluster_arn" \
    --service "${service_names[$index]}" \
    --task-definition "${task_definitions[$index]}" \
    --force-new-deployment \
    >/dev/null
done

aws ecs wait services-stable \
  --cluster "$ecs_cluster_arn" \
  --services "${service_names[@]}"
