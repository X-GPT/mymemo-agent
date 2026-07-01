#!/usr/bin/env bash
set -euo pipefail

config="${DEPLOY_CONFIG:-infra/deploy/prod.env}"
if [[ -f "$config" ]]; then
  # shellcheck disable=SC1090
  source "$config"
fi

ecs_cluster_arn="$(
  terraform -chdir=infra/terraform output -raw shared_ecs_cluster_arn
)"

chat_api_service_name="$(
  terraform -chdir=infra/terraform output -raw chat_api_service_name
)"

agent_worker_service_name="$(
  terraform -chdir=infra/terraform output -raw agent_worker_service_name
)"

aws ecs update-service \
  --cluster "$ecs_cluster_arn" \
  --service "$chat_api_service_name" \
  --force-new-deployment \
  >/dev/null

aws ecs update-service \
  --cluster "$ecs_cluster_arn" \
  --service "$agent_worker_service_name" \
  --force-new-deployment \
  >/dev/null

aws ecs wait services-stable \
  --cluster "$ecs_cluster_arn" \
  --services "$chat_api_service_name" "$agent_worker_service_name"
