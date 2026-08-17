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
  DEPLOY_ENVIRONMENT
)

for name in "${required[@]}"; do
  require_value "$name"
done

image_tag="${IMAGE_TAG:-}"
chat_api_image="${CHAT_API_IMAGE:-}"
agent_worker_image="${AGENT_WORKER_IMAGE:-}"
agentcore_dispatch_publisher_image="${AGENTCORE_DISPATCH_PUBLISHER_IMAGE:-}"

if [[ -n "$chat_api_image" || -n "$agent_worker_image" || -n "$agentcore_dispatch_publisher_image" ]]; then
  if [[ -z "$chat_api_image" || -z "$agent_worker_image" || -z "$agentcore_dispatch_publisher_image" ]]; then
    echo "Set CHAT_API_IMAGE, AGENT_WORKER_IMAGE, and AGENTCORE_DISPATCH_PUBLISHER_IMAGE together, or set none and provide IMAGE_TAG." >&2
    exit 1
  fi
else
  if is_placeholder "$image_tag"; then
    echo "IMAGE_TAG is required when explicit service images are not set" >&2
    exit 1
  fi
  chat_api_repository_url="$(terraform -chdir=infra/ecr output -raw chat_api_ecr_repository_url)"
  agent_worker_repository_url="$(terraform -chdir=infra/ecr output -raw agent_worker_ecr_repository_url)"
  agentcore_dispatch_publisher_repository_url="$(terraform -chdir=infra/ecr output -raw agentcore_dispatch_publisher_ecr_repository_url)"
  chat_api_image="${chat_api_repository_url}:${image_tag}"
  agent_worker_image="${agent_worker_repository_url}:${image_tag}"
  agentcore_dispatch_publisher_image="${agentcore_dispatch_publisher_repository_url}:${image_tag}"
fi

mkdir -p "$(dirname "$out")"

cat >"$out" <<TFVARS
aws_region                            = "${AWS_REGION}"
chat_api_image                        = "${chat_api_image}"
agent_worker_image                    = "${agent_worker_image}"
agentcore_dispatch_publisher_image    = "${agentcore_dispatch_publisher_image}"
TFVARS

echo "Wrote $out"
echo "Deploy config summary:"
echo "  environment: ${DEPLOY_ENVIRONMENT}"
echo "  region: ${AWS_REGION}"
echo "  chat-api image: ${chat_api_image}"
echo "  agent-worker image: ${agent_worker_image}"
echo "  AgentCore dispatch publisher image: ${agentcore_dispatch_publisher_image}"
