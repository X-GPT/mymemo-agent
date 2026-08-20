#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"
source "scripts/deploy/agentcore_aws_checks.sh"

aws_profile="mymemo"
region="us-west-2"
account_id="637423444544"
repository="X-GPT/mymemo-agent"
terraform_dir="infra/agentcore"
enabled_parameter="/mymemo/agentcore-dispatch/prod/enabled"
zero_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"
ca_digest="e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3"
confirmation="${1:-}"
requested_digest="${2:-}"

if [[ "${confirmation}" != "deploy-mymemo-agentcore-prod" || $# -gt 2 ]]; then
  echo "Usage: $0 deploy-mymemo-agentcore-prod [sha256:<existing-digest>]" >&2
  exit 1
fi
if [[ -n "${requested_digest}" && ! "${requested_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Existing Runtime image must be an exact sha256 digest." >&2
  exit 1
fi

for command in aws bun curl docker gh git jq terraform; do
  if ! command -v "${command}" >/dev/null; then
    echo "${command} is required" >&2
    exit 1
  fi
done

if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "Run the AgentCore production deployment from the reviewed main branch." >&2
  exit 1
fi
if [[ -n "$(git status --short)" ]]; then
  echo "Run the AgentCore production deployment from a clean worktree." >&2
  exit 1
fi
git fetch --quiet origin main
commit_sha="$(git rev-parse HEAD)"
if [[ "${commit_sha}" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main must match origin/main before AgentCore production deployment." >&2
  exit 1
fi

caller_account="$(aws --profile "${aws_profile}" sts get-caller-identity --query Account --output text)"
if [[ "${caller_account}" != "${account_id}" ]]; then
  echo "The mymemo profile must target AWS account ${account_id}." >&2
  exit 1
fi

parameter_error="$(mktemp /tmp/mymemo-agentcore-parameter.XXXXXX)"
ca_bundle="$(mktemp /tmp/mymemo-agentcore-ca.XXXXXX)"
trap 'rm -f "${parameter_error}" "${ca_bundle}"' EXIT

assert_dispatch_disabled() {
  local parameter_value

  if parameter_value="$(aws --profile "${aws_profile}" ssm get-parameter --region "${region}" --name "${enabled_parameter}" --query Parameter.Value --output text 2>"${parameter_error}")"; then
    if [[ "${parameter_value}" != "disabled" ]]; then
      echo "${enabled_parameter} must be disabled before idle production deployment" >&2
      return 1
    fi
  elif ! grep -Fq "ParameterNotFound" "${parameter_error}"; then
    cat "${parameter_error}" >&2
    return 1
  fi
}

assert_dispatch_disabled

github_variable() {
  gh variable get "$1" --repo "${repository}"
}

copy_agentcore_runtime_digest() {
  local digest="$1"
  local migration_tag="migration-${digest#sha256:}"
  local legacy_repository_uri="${account_id}.dkr.ecr.${region}.amazonaws.com/mymemo/agentcore-canary-runtime"
  local copied_digest

  if aws --profile "${aws_profile}" ecr describe-images \
    --region "${region}" \
    --repository-name mymemo/agentcore-runtime \
    --image-ids imageDigest="${digest}" >/dev/null 2>&1; then
    return
  fi

  docker pull --platform linux/arm64 "${legacy_repository_uri}@${digest}"
  docker tag "${legacy_repository_uri}@${digest}" "${repository_uri}:${migration_tag}"
  docker push "${repository_uri}:${migration_tag}"
  copied_digest="$(aws --profile "${aws_profile}" ecr describe-images \
    --region "${region}" \
    --repository-name mymemo/agentcore-runtime \
    --image-ids imageTag="${migration_tag}" \
    --query 'imageDetails[0].imageDigest' \
    --output text)"
  if [[ "${copied_digest}" != "${digest}" ]]; then
    echo "Copied Runtime image digest does not match ${digest}." >&2
    exit 1
  fi
}

export AWS_PROFILE="${aws_profile}"
export AWS_REGION="${region}"
export TF_INPUT=false
export TF_IN_AUTOMATION=true
export TF_VAR_aws_region="${region}"
export TF_VAR_aws_account_id="${account_id}"
export TF_VAR_runtime_image_digest="${zero_digest}"
export TF_VAR_consumer_lambda_package="${repo_root}/dist/agentcore-consumer/consumer.zip"
export TF_VAR_agent_database_url_secret_arn="$(github_variable AGENTCORE_AGENT_DATABASE_URL_SECRET_ARN)"
export TF_VAR_kb_database_url_secret_arn="$(github_variable AGENTCORE_KB_DATABASE_URL_SECRET_ARN)"
export TF_VAR_openrouter_api_key_secret_arn="$(github_variable AGENTCORE_OPENROUTER_API_KEY_SECRET_ARN)"
export TF_VAR_e2b_api_key_secret_arn="$(github_variable AGENTCORE_E2B_API_KEY_SECRET_ARN)"
export TF_VAR_redis_url_secret_arn="$(github_variable AGENTCORE_REDIS_URL_SECRET_ARN)"
export TF_VAR_artifact_bucket_name="mymemo-agent-prod-artifacts"
export TF_VAR_openrouter_default_model="$(github_variable AGENTCORE_OPENROUTER_DEFAULT_MODEL)"
export TF_VAR_alarm_action_arns="$(github_variable AGENTCORE_ALARM_ACTION_ARNS_JSON)"
export TF_VAR_retain_legacy_runtime_repository=false

deployment_id="${commit_sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
record_dir="${repo_root}/dist/agentcore-deployment/${deployment_id}"
mkdir -p "${record_dir}"

curl --fail --silent --show-error --location \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  --output "${ca_bundle}"
if command -v sha256sum >/dev/null; then
  echo "${ca_digest}  ${ca_bundle}" | sha256sum --check
else
  echo "${ca_digest}  ${ca_bundle}" | shasum -a 256 --check
fi

bun install --frozen-lockfile
scripts/deploy/build_agentcore_consumer.sh \
  dist/agentcore-consumer \
  "${ca_bundle}"

terraform -chdir="${terraform_dir}" init
terraform -chdir="${terraform_dir}" fmt -check
terraform -chdir="${terraform_dir}" validate

# Resolve rollback evidence before the repository-only apply. Keeping the
# previous digest in TF_VAR prevents that targeted first phase from replacing a
# real deployed output with the repository-only zero sentinel.
previous_outputs="$(terraform -chdir="${terraform_dir}" output -json)"
previous_runtime_image_digest="$(jq -r '.runtime_image_digest.value // ""' <<<"${previous_outputs}")"
previous_runtime_repository_url="$(jq -r '.runtime_repository_url.value // ""' <<<"${previous_outputs}")"
case "${previous_runtime_image_digest}" in
  "")
    export TF_VAR_runtime_image_digest="${zero_digest}"
    ;;
  "${zero_digest}")
    previous_runtime_image_digest=""
    export TF_VAR_runtime_image_digest="${zero_digest}"
    ;;
  sha256:*)
    if [[ ! "${previous_runtime_image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "Terraform state contains an invalid rollback digest" >&2
      exit 1
    fi
    export TF_VAR_runtime_image_digest="${previous_runtime_image_digest}"
    ;;
  *)
    echo "Terraform state contains an invalid rollback digest" >&2
    exit 1
    ;;
esac
export ROLLBACK_RUNTIME_IMAGE_DIGEST="${previous_runtime_image_digest}"

legacy_repository_migration=false
if [[ "${previous_runtime_repository_url}" == */mymemo/agentcore-canary-runtime ]] ||
  terraform -chdir="${terraform_dir}" state list 2>/dev/null |
    grep -Eq '^aws_ecr_repository\.(runtime|legacy_runtime\[0\])$'; then
  legacy_repository_migration=true
  export TF_VAR_retain_legacy_runtime_repository=true
fi

# Create the production repository while retaining the Terraform-managed legacy
# repository. The old deployed digest is copied only after both coexist.
repository_plan="${record_dir}/repository.tfplan"
repository_targets=(-target=aws_ecr_repository.production_runtime)
if [[ "${legacy_repository_migration}" == true ]]; then
  repository_targets+=('-target=aws_ecr_repository.legacy_runtime[0]')
fi
terraform -chdir="${terraform_dir}" plan "${repository_targets[@]}" -out="${repository_plan}"
scripts/deploy/classify_agentcore_plan.sh "${repository_plan}"
terraform -chdir="${terraform_dir}" show -json "${repository_plan}" >"${record_dir}/repository-plan.json"
terraform -chdir="${terraform_dir}" apply "${repository_plan}"

repository_uri="$(terraform -chdir="${terraform_dir}" output -raw runtime_repository_url)"
aws --profile "${aws_profile}" ecr get-login-password --region "${region}" |
  docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${region}.amazonaws.com"

if [[ "${legacy_repository_migration}" == true ]]; then
  if [[ -n "${previous_runtime_image_digest}" ]]; then
    copy_agentcore_runtime_digest "${previous_runtime_image_digest}"
  fi
  if [[ -n "${requested_digest}" && "${requested_digest}" != "${previous_runtime_image_digest}" ]]; then
    copy_agentcore_runtime_digest "${requested_digest}"
  fi
fi

if [[ -z "${requested_digest}" ]]; then
  docker buildx build \
    --platform linux/arm64 \
    --load \
    --file apps/agentcore-runtime/Dockerfile \
    --tag mymemo-agentcore-runtime:verified \
    .
  scripts/smoke/agentcore-runtime-image-check.sh mymemo-agentcore-runtime:verified
  image_tag="manual-${commit_sha:0:12}-$(date -u +%Y%m%d%H%M%S)"
  docker tag mymemo-agentcore-runtime:verified "${repository_uri}:${image_tag}"
  docker push "${repository_uri}:${image_tag}"
  runtime_image_digest="$(aws --profile "${aws_profile}" ecr describe-images --region "${region}" --repository-name mymemo/agentcore-runtime --image-ids imageTag="${image_tag}" --query 'imageDetails[0].imageDigest' --output text)"
  aws --profile "${aws_profile}" ecr wait image-scan-complete --region "${region}" --repository-name mymemo/agentcore-runtime --image-id imageDigest="${runtime_image_digest}"
else
  runtime_image_digest="${requested_digest}"
  aws --profile "${aws_profile}" ecr describe-images --region "${region}" --repository-name mymemo/agentcore-runtime --image-ids imageDigest="${runtime_image_digest}" --query 'imageDetails[0].imageDigest' --output text | grep -Fxq "${runtime_image_digest}"
  docker pull --platform linux/arm64 "${repository_uri}@${runtime_image_digest}"
  docker tag "${repository_uri}@${runtime_image_digest}" agentcore-existing:verified
  if [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' agentcore-existing:verified)" != "linux/arm64" ]]; then
    echo "Existing Runtime image must be linux/arm64." >&2
    exit 1
  fi
  scripts/smoke/agentcore-runtime-image-check.sh agentcore-existing:verified
fi
export TF_VAR_runtime_image_digest="${runtime_image_digest}"
export EXPECTED_RUNTIME_IMAGE_DIGEST="${runtime_image_digest}"

assert_dispatch_disabled
assert_agentcore_legacy_queues_empty "${region}" |
  tee "${record_dir}/legacy-queue-precondition.json" >/dev/null

deployment_plan="${record_dir}/deployment.tfplan"
terraform -chdir="${terraform_dir}" plan -out="${deployment_plan}"
scripts/deploy/classify_agentcore_plan.sh "${deployment_plan}"
terraform -chdir="${terraform_dir}" show -json "${deployment_plan}" >"${record_dir}/deployment-plan.json"
terraform -chdir="${terraform_dir}" show -no-color "${deployment_plan}" >"${record_dir}/deployment-plan.txt"
terraform -chdir="${terraform_dir}" apply "${deployment_plan}"

runtime_id="$(terraform -chdir="${terraform_dir}" output -raw agent_runtime_id)"
runtime="$(aws --profile "${aws_profile}" bedrock-agentcore-control get-agent-runtime --region "${region}" --agent-runtime-id "${runtime_id}")"
# hashicorp/aws 6.x does not expose metadataConfiguration on the native Runtime.
if ! jq -e '.metadataConfiguration.requireMMDSV2 == true' <<<"${runtime}" >/dev/null; then
  jq '{agentRuntimeId, agentRuntimeArtifact, roleArn, networkConfiguration, description, protocolConfiguration, lifecycleConfiguration, environmentVariables, metadataConfiguration:{requireMMDSV2:true}} | with_entries(select(.value != null))' <<<"${runtime}" >"${record_dir}/mmdsv2-update.json"
  aws --profile "${aws_profile}" bedrock-agentcore-control update-agent-runtime --region "${region}" --cli-input-json "file://${record_dir}/mmdsv2-update.json"
fi

status=""
for _ in $(seq 1 60); do
  status="$(aws --profile "${aws_profile}" bedrock-agentcore-control get-agent-runtime --region "${region}" --agent-runtime-id "${runtime_id}" --query status --output text)"
  [[ "${status}" == "READY" ]] && break
  [[ "${status}" == "CREATE_FAILED" || "${status}" == "UPDATE_FAILED" ]] && exit 1
  sleep 10
done
[[ "${status}" == "READY" ]]

endpoint_status=""
for _ in $(seq 1 60); do
  endpoint_status="$(aws --profile "${aws_profile}" bedrock-agentcore-control get-agent-runtime-endpoint --region "${region}" --agent-runtime-id "${runtime_id}" --endpoint-name DEFAULT --query status --output text)"
  [[ "${endpoint_status}" == "READY" ]] && break
  [[ "${endpoint_status}" == "CREATE_FAILED" || "${endpoint_status}" == "UPDATE_FAILED" ]] && exit 1
  sleep 10
done
[[ "${endpoint_status}" == "READY" ]]

runtime="$(aws --profile "${aws_profile}" bedrock-agentcore-control get-agent-runtime --region "${region}" --agent-runtime-id "${runtime_id}")"
jq -e '.metadataConfiguration.requireMMDSV2 == true' <<<"${runtime}" >/dev/null
runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
endpoint="$(aws --profile "${aws_profile}" bedrock-agentcore-control get-agent-runtime-endpoint --region "${region}" --agent-runtime-id "${runtime_id}" --endpoint-name DEFAULT)"
jq -e --arg version "${runtime_version}" '.name == "DEFAULT" and .status == "READY" and .liveVersion == $version' <<<"${endpoint}" >/dev/null

if [[ "${legacy_repository_migration}" == true ]]; then
  export TF_VAR_retain_legacy_runtime_repository=false
  legacy_cleanup_plan="${record_dir}/legacy-repository-cleanup.tfplan"
  terraform -chdir="${terraform_dir}" plan -out="${legacy_cleanup_plan}"
  scripts/deploy/classify_agentcore_plan.sh "${legacy_cleanup_plan}"
  terraform -chdir="${terraform_dir}" show -json "${legacy_cleanup_plan}" >"${record_dir}/legacy-repository-cleanup-plan.json"
  terraform -chdir="${terraform_dir}" show -no-color "${legacy_cleanup_plan}" >"${record_dir}/legacy-repository-cleanup-plan.txt"
  terraform -chdir="${terraform_dir}" apply "${legacy_cleanup_plan}"
fi

scripts/deploy/inspect_agentcore.sh | tee "${record_dir}/idle-inspection.json"
jq -n \
  --arg commit "${commit_sha}" \
  --arg runtimeImageDigest "${runtime_image_digest}" \
  --arg rollbackImageDigest "${previous_runtime_image_digest}" \
  --arg runtimeVersion "${runtime_version}" \
  --arg recordDirectory "${record_dir}" \
  '{commit:$commit,runtimeImageDigest:$runtimeImageDigest,rollbackImageDigest:$rollbackImageDigest,runtimeVersion:$runtimeVersion,recordDirectory:$recordDirectory}' |
  tee "${record_dir}/deployment-record.json"
