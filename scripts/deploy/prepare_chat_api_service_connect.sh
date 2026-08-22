#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

ecs_cluster_arn="$(terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn)"
chat_api_service_name="$(terraform -chdir=infra/terraform output -raw chat_api_service_name)"
desired_task_definition="$(terraform -chdir=infra/terraform output -raw chat_api_task_definition_arn)"
port_name="chat-api-http"

current_task_definition="$(
  aws ecs describe-services \
    --cluster "$ecs_cluster_arn" \
    --services "$chat_api_service_name" \
    --query 'services[0].taskDefinition' \
    --output text
)"

task_definition_has_service_connect_port() {
  local task_definition="$1"

  aws ecs describe-task-definition \
    --task-definition "$task_definition" \
    --query taskDefinition \
    --output json \
    | jq -e \
      --arg port_name "$port_name" \
      'any(.containerDefinitions[] | select(.name == "chat-api").portMappings[]; .name == $port_name and .appProtocol == "http")' \
      >/dev/null
}

if task_definition_has_service_connect_port "$current_task_definition"; then
  echo "chat-api already uses the named HTTP port required by Service Connect."
  exit 0
fi

if ! task_definition_has_service_connect_port "$desired_task_definition"; then
  echo "Terraform's chat-api task definition is missing the named HTTP port required by Service Connect." >&2
  exit 1
fi

# The ECS service resource intentionally ignores task_definition changes. Roll
# the named-port revision first so the later unified Terraform apply can enable
# Service Connect without ECS validating portName against the previous revision.
aws ecs update-service \
  --cluster "$ecs_cluster_arn" \
  --service "$chat_api_service_name" \
  --task-definition "$desired_task_definition" \
  --force-new-deployment \
  >/dev/null

aws ecs wait services-stable \
  --cluster "$ecs_cluster_arn" \
  --services "$chat_api_service_name"
