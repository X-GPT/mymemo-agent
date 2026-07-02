#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/deploy/build_and_push_agent_image.sh <chat-api|agent-worker>

Required env:
  AWS_REGION
  IMAGE_TAG
USAGE
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

service="$1"
case "$service" in
  chat-api)
    dockerfile="apps/chat-api/Dockerfile"
    output_name="chat_api_ecr_repository_url"
    ;;
  agent-worker)
    dockerfile="apps/agent-worker/Dockerfile"
    output_name="agent_worker_ecr_repository_url"
    ;;
  *)
    usage
    exit 2
    ;;
esac

: "${AWS_REGION:?AWS_REGION is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

repository_url="$(terraform -chdir=infra/ecr output -raw "$output_name")"
registry="${repository_url%%/*}"
image="${repository_url}:${IMAGE_TAG}"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$registry"

docker build --platform linux/amd64 -f "$dockerfile" -t "$image" .
docker push "$image"

echo "$image"
