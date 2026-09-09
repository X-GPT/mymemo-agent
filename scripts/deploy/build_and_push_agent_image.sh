#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

: "${AWS_REGION:?AWS_REGION is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

repository_url="$(terraform -chdir=infra/ecr output -raw agent_runtime_ecr_repository_url)"
registry="${repository_url%%/*}"
image="${repository_url}:${IMAGE_TAG}"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$registry"

docker build --platform linux/arm64 -f apps/agent-runtime/Dockerfile -t "$image" .
"$script_dir/../smoke/agentcore-runtime-image-check.sh" "$image"
docker push "$image"

echo "$image"
