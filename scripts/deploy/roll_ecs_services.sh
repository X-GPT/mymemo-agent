#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

runtime_awareness_label="com.mymemo.agent-worker.execution-runtime-aware"

read_agent_worker_runtime_awareness() {
  local image="$1"
  local registry image_path repository_name image_id manifest config_digest download_url

  registry="${image%%/*}"
  image_path="${image#*/}"
  if [[ "$registry" == "$image" ]]; then
    echo "Agent-worker task definition does not reference an ECR image: $image" >&2
    return 1
  fi
  if [[ "$image_path" == *@sha256:* ]]; then
    repository_name="${image_path%@*}"
    image_id="imageDigest=${image_path#*@}"
  elif [[ "$image_path" == *:* ]]; then
    repository_name="${image_path%:*}"
    image_id="imageTag=${image_path##*:}"
  else
    repository_name="$image_path"
    image_id="imageTag=latest"
  fi

  manifest="$(
    aws ecr batch-get-image \
      --region "$AWS_REGION" \
      --registry-id "${registry%%.*}" \
      --repository-name "$repository_name" \
      --image-ids "$image_id" \
      --accepted-media-types \
        application/vnd.docker.distribution.manifest.v2+json \
        application/vnd.oci.image.manifest.v1+json \
      --query 'images[0].imageManifest' \
      --output text
  )"
  if [[ -z "$manifest" || "$manifest" == "None" ]]; then
    echo "Could not load the agent-worker image manifest for $image" >&2
    return 1
  fi
  config_digest="$(
    bun -e 'const manifest = JSON.parse(process.argv[1]); if (typeof manifest.config?.digest !== "string") throw new Error("image manifest has no config digest"); console.log(manifest.config.digest);' \
      "$manifest"
  )"
  download_url="$(
    aws ecr get-download-url-for-layer \
      --region "$AWS_REGION" \
      --registry-id "${registry%%.*}" \
      --repository-name "$repository_name" \
      --layer-digest "$config_digest" \
      --query downloadUrl \
      --output text
  )"
  bun -e 'const response = await fetch(process.argv[1]); if (!response.ok) throw new Error(`image config download failed: ${response.status}`); const imageConfig = await response.json(); console.log(imageConfig.config?.Labels?.[process.argv[2]] === "true" ? "true" : "false");' \
    "$download_url" \
    "$runtime_awareness_label"
}

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

agent_worker_task_definition="${AGENT_WORKER_TASK_DEFINITION_ARN:-$(
  terraform -chdir=infra/terraform output -raw agent_worker_task_definition_arn
)}"

candidate_image="$(
  aws ecs describe-task-definition \
    --task-definition "$agent_worker_task_definition" \
    --query 'taskDefinition.containerDefinitions[?name==`agent-worker`] | [0].image' \
    --output text
)"
candidate_runtime_aware="$(read_agent_worker_runtime_awareness "$candidate_image")"

"$script_dir/run_execution_runtime_deployment_assertion.sh" \
  prepare-fargate-deployment \
  "$candidate_runtime_aware"

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

expected_task_definition="$agent_worker_task_definition"
service_task_definition="$(
  aws ecs describe-services \
    --cluster "$ecs_cluster_arn" \
    --services "$agent_worker_service_name" \
    --query 'services[0].taskDefinition' \
    --output text
)"
running_task_arns="$(
  aws ecs list-tasks \
    --cluster "$ecs_cluster_arn" \
    --service-name "$agent_worker_service_name" \
    --desired-status RUNNING \
    --query 'taskArns' \
    --output text
)"
stopping_task_arns="$(
  aws ecs list-tasks \
    --cluster "$ecs_cluster_arn" \
    --service-name "$agent_worker_service_name" \
    --desired-status STOPPED \
    --query 'taskArns' \
    --output text
)"
if [[ "$running_task_arns" == "None" ]]; then
  running_task_arns=""
fi
if [[ "$stopping_task_arns" == "None" ]]; then
  stopping_task_arns=""
fi
active_task_arns="$running_task_arns $stopping_task_arns"

if [[ "$service_task_definition" != "$expected_task_definition" ]]; then
  echo "Fargate deployment is not fully execution-runtime-aware: service uses $service_task_definition, expected $expected_task_definition" >&2
  exit 1
fi

if [[ -n "${active_task_arns// /}" ]]; then
  active_task_definitions="$(
    # Intentional word splitting: AWS emits one tab-separated ARN per task.
    # shellcheck disable=SC2086
    aws ecs describe-tasks \
      --cluster "$ecs_cluster_arn" \
      --tasks $active_task_arns \
      --query 'tasks[?lastStatus != `STOPPED`].taskDefinitionArn' \
      --output text
  )"
  for task_definition in $active_task_definitions; do
    if [[ "$task_definition" != "$expected_task_definition" ]]; then
      echo "Fargate deployment is not fully execution-runtime-aware: active task uses $task_definition, expected $expected_task_definition" >&2
      exit 1
    fi
  done
fi

if [[ "$candidate_runtime_aware" == "true" ]]; then
  "$script_dir/run_execution_runtime_deployment_assertion.sh" \
    mark-fargate-runtime-aware
fi
