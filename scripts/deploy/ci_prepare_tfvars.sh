#!/usr/bin/env bash
set -euo pipefail

out="${1:-infra/terraform/generated.auto.tfvars}"

is_placeholder() {
  local value="${1:-}"
  [[ -z "$value" || "$value" == REPLACE_ME* || "$value" == TODO* || "$value" == *"<"*">"* ]]
}

require_value() {
  local name="$1"
  local value="${!name:-}"
  if is_placeholder "$value"; then
    echo "$name is required in the environment" >&2
    exit 1
  fi
}

required=(
  AWS_REGION
  AWS_ACCOUNT_ID
  DEPLOY_ENVIRONMENT
)

for name in "${required[@]}"; do
  require_value "$name"
done

image_tag="${IMAGE_TAG:-}"
if [[ -z "${CHAT_API_IMAGE:-}" || -z "${AGENT_WORKER_IMAGE:-}" ]]; then
  if is_placeholder "$image_tag"; then
    echo "IMAGE_TAG is required when CHAT_API_IMAGE and AGENT_WORKER_IMAGE are not set" >&2
    exit 1
  fi
  CHAT_API_IMAGE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/mymemo-agent-chat-api:${image_tag}"
  AGENT_WORKER_IMAGE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/mymemo-agent-worker:${image_tag}"
fi

mkdir -p "$(dirname "$out")"

cat >"$out" <<TFVARS
chat_api_image     = "${CHAT_API_IMAGE}"
agent_worker_image = "${AGENT_WORKER_IMAGE}"
TFVARS

echo "Wrote $out"
echo "Deploy config summary:"
echo "  environment: ${DEPLOY_ENVIRONMENT}"
echo "  region/account: ${AWS_REGION}/${AWS_ACCOUNT_ID}"
echo "  chat-api image: ${CHAT_API_IMAGE}"
echo "  agent-worker image: ${AGENT_WORKER_IMAGE}"
