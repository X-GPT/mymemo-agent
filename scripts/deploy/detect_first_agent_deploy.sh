#!/usr/bin/env bash
set -euo pipefail

terraform -chdir=infra/terraform init >/dev/null

state="$(
  terraform -chdir=infra/terraform state list 2>/dev/null || true
)"

if [[ "$state" == *"aws_ecs_service.chat_api"* && "$state" == *"aws_ecs_service.agent_worker"* ]]; then
  echo "false"
else
  echo "true"
fi
