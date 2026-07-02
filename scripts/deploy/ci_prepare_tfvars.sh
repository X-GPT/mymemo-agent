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

require_url() {
  local name="$1"
  local value="${!name:-}"
  require_value "$name"
  if [[ ! "$value" =~ ^https?://[^[:space:]\"\\]+$ ]]; then
    echo "$name must be an http(s) URL without whitespace, quotes, or backslashes" >&2
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

require_url GATEWAY_PUBLIC_URL

image_tag="${IMAGE_TAG:-}"
chat_api_image="${CHAT_API_IMAGE:-}"
agent_worker_image="${AGENT_WORKER_IMAGE:-}"

if [[ -n "$chat_api_image" || -n "$agent_worker_image" ]]; then
  if [[ -z "$chat_api_image" || -z "$agent_worker_image" ]]; then
    echo "Set both CHAT_API_IMAGE and AGENT_WORKER_IMAGE, or set neither and provide IMAGE_TAG." >&2
    exit 1
  fi
else
  if is_placeholder "$image_tag"; then
    echo "IMAGE_TAG is required when CHAT_API_IMAGE and AGENT_WORKER_IMAGE are not set" >&2
    exit 1
  fi
  chat_api_repository_url="$(terraform -chdir=infra/ecr output -raw chat_api_ecr_repository_url)"
  agent_worker_repository_url="$(terraform -chdir=infra/ecr output -raw agent_worker_ecr_repository_url)"
  chat_api_image="${chat_api_repository_url}:${image_tag}"
  agent_worker_image="${agent_worker_repository_url}:${image_tag}"
fi

mkdir -p "$(dirname "$out")"

cat >"$out" <<TFVARS
aws_region         = "${AWS_REGION}"
chat_api_image     = "${chat_api_image}"
agent_worker_image = "${agent_worker_image}"
gateway_public_url = "${GATEWAY_PUBLIC_URL}"
TFVARS

echo "Wrote $out"
echo "Deploy config summary:"
echo "  environment: ${DEPLOY_ENVIRONMENT}"
echo "  region: ${AWS_REGION}"
echo "  gateway URL: ${GATEWAY_PUBLIC_URL}"
echo "  chat-api image: ${chat_api_image}"
echo "  agent-worker image: ${agent_worker_image}"
