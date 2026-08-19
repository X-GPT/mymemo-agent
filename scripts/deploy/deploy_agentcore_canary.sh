#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

aws_profile="mymemo"
region="us-west-2"
account_id="637423444544"
repository="X-GPT/mymemo-agent"
terraform_dir="infra/agentcore-canary"
enabled_parameter="/mymemo/agentcore-dispatch/prod/enabled"
zero_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"
ca_digest="e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3"
confirmation="${1:-}"
requested_digest="${2:-}"

if [[ "${confirmation}" != "deploy-mymemo-agentcore-canary-prod" || $# -gt 2 ]]; then
  echo "Usage: $0 deploy-mymemo-agentcore-canary-prod [sha256:<existing-digest>]" >&2
  exit 1
fi

for command in aws bun curl docker gh git jq terraform; do
  if ! command -v "${command}" >/dev/null; then
    echo "${command} is required" >&2
    exit 1
  fi
done

if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "Run the canary deployment from the reviewed main branch." >&2
  exit 1
fi
if [[ -n "$(git status --short)" ]]; then
  echo "Run the canary deployment from a clean worktree." >&2
  exit 1
fi
git fetch --quiet origin main
commit_sha="$(git rev-parse HEAD)"
if [[ "${commit_sha}" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main must match origin/main before canary deployment." >&2
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
if parameter_value="$(aws --profile "${aws_profile}" ssm get-parameter --region "${region}" --name "${enabled_parameter}" --query Parameter.Value --output text 2>"${parameter_error}")"; then
  if [[ "${parameter_value}" != "disabled" ]]; then
    echo "${enabled_parameter} must be disabled before dormant deployment" >&2
    exit 1
  fi
elif ! grep -Fq "ParameterNotFound" "${parameter_error}"; then
  cat "${parameter_error}" >&2
  exit 1
fi

github_variable() {
  gh variable get "$1" --repo "${repository}"
}

export AWS_PROFILE="${aws_profile}"
export AWS_REGION="${region}"
export TF_INPUT=false
export TF_IN_AUTOMATION=true
export TF_VAR_aws_region="${region}"
export TF_VAR_aws_account_id="${account_id}"
export TF_VAR_runtime_image_digest="${zero_digest}"
export TF_VAR_dispatch_lambda_package="${repo_root}/dist/agentcore-canary-lambdas/dispatch.zip"
export TF_VAR_agent_database_url_secret_arn="$(github_variable AGENTCORE_CANARY_AGENT_DATABASE_URL_SECRET_ARN)"
export TF_VAR_kb_database_url_secret_arn="$(github_variable AGENTCORE_CANARY_KB_DATABASE_URL_SECRET_ARN)"
export TF_VAR_openrouter_api_key_secret_arn="$(github_variable AGENTCORE_CANARY_OPENROUTER_API_KEY_SECRET_ARN)"
export TF_VAR_e2b_api_key_secret_arn="$(github_variable AGENTCORE_CANARY_E2B_API_KEY_SECRET_ARN)"
export TF_VAR_redis_url_secret_arn="$(github_variable AGENTCORE_CANARY_REDIS_URL_SECRET_ARN)"
export TF_VAR_artifact_bucket_name="mymemo-agent-prod-artifacts"
export TF_VAR_openrouter_default_model="$(github_variable AGENTCORE_CANARY_OPENROUTER_DEFAULT_MODEL)"
export TF_VAR_incident_alarm_action_arns="$(github_variable AGENTCORE_CANARY_INCIDENT_ALARM_ARNS_JSON)"
export TF_VAR_dispatch_enabled=false

deployment_id="${commit_sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
record_dir="${repo_root}/dist/agentcore-canary-deployment/${deployment_id}"
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
scripts/deploy/build_agentcore_canary_lambdas.sh \
  dist/agentcore-canary-lambdas \
  "${ca_bundle}"

terraform -chdir="${terraform_dir}" init
terraform -chdir="${terraform_dir}" fmt -check
terraform -chdir="${terraform_dir}" validate

# Resolve rollback evidence before the repository-only apply. Keeping the
# previous digest in TF_VAR prevents that targeted first phase from replacing a
# real deployed output with the repository-only zero sentinel.
previous_outputs="$(terraform -chdir="${terraform_dir}" output -json)"
previous_runtime_image_digest="$(jq -r '.runtime_image_digest.value // ""' <<<"${previous_outputs}")"
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

# The immutable repository must exist before the selected image can be pushed.
# This is the first phase of the same operator deployment, under the same plan
# classifier and credentials; it is not a separate bootstrap authority.
repository_plan="${record_dir}/repository.tfplan"
terraform -chdir="${terraform_dir}" plan \
  -target=aws_ecr_repository.runtime \
  -out="${repository_plan}"
scripts/deploy/classify_agentcore_canary_plan.sh "${repository_plan}"
terraform -chdir="${terraform_dir}" show -json "${repository_plan}" >"${record_dir}/repository-plan.json"
terraform -chdir="${terraform_dir}" apply "${repository_plan}"

repository_uri="$(terraform -chdir="${terraform_dir}" output -raw runtime_repository_url)"
aws --profile "${aws_profile}" ecr get-login-password --region "${region}" |
  docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${region}.amazonaws.com"

if [[ -z "${requested_digest}" ]]; then
  docker buildx build \
    --platform linux/arm64 \
    --load \
    --file apps/agentcore-canary-runtime/Dockerfile \
    --tag mymemo-agentcore-canary-runtime:verified \
    .
  scripts/smoke/agentcore-canary-runtime-image-check.sh mymemo-agentcore-canary-runtime:verified
  image_tag="manual-${commit_sha:0:12}-$(date -u +%Y%m%d%H%M%S)"
  docker tag mymemo-agentcore-canary-runtime:verified "${repository_uri}:${image_tag}"
  docker push "${repository_uri}:${image_tag}"
  runtime_image_digest="$(aws --profile "${aws_profile}" ecr describe-images --region "${region}" --repository-name mymemo/agentcore-canary-runtime --image-ids imageTag="${image_tag}" --query 'imageDetails[0].imageDigest' --output text)"
  aws --profile "${aws_profile}" ecr wait image-scan-complete --region "${region}" --repository-name mymemo/agentcore-canary-runtime --image-id imageDigest="${runtime_image_digest}"
else
  runtime_image_digest="${requested_digest}"
  if [[ ! "${runtime_image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Existing Runtime image must be an exact sha256 digest." >&2
    exit 1
  fi
  aws --profile "${aws_profile}" ecr describe-images --region "${region}" --repository-name mymemo/agentcore-canary-runtime --image-ids imageDigest="${runtime_image_digest}" --query 'imageDetails[0].imageDigest' --output text | grep -Fxq "${runtime_image_digest}"
  docker pull --platform linux/arm64 "${repository_uri}@${runtime_image_digest}"
  docker tag "${repository_uri}@${runtime_image_digest}" agentcore-canary-existing:verified
  if [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' agentcore-canary-existing:verified)" != "linux/arm64" ]]; then
    echo "Existing Runtime image must be linux/arm64." >&2
    exit 1
  fi
  scripts/smoke/agentcore-canary-runtime-image-check.sh agentcore-canary-existing:verified
fi
export TF_VAR_runtime_image_digest="${runtime_image_digest}"
export EXPECTED_RUNTIME_IMAGE_DIGEST="${runtime_image_digest}"

deployment_plan="${record_dir}/deployment.tfplan"
terraform -chdir="${terraform_dir}" plan -out="${deployment_plan}"
scripts/deploy/classify_agentcore_canary_plan.sh "${deployment_plan}"
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

scripts/deploy/inspect_agentcore_canary_dormant.sh | tee "${record_dir}/dormant-inspection.json"
jq -n \
  --arg commit "${commit_sha}" \
  --arg runtimeImageDigest "${runtime_image_digest}" \
  --arg rollbackImageDigest "${previous_runtime_image_digest}" \
  --arg runtimeVersion "${runtime_version}" \
  --arg recordDirectory "${record_dir}" \
  '{commit:$commit,runtimeImageDigest:$runtimeImageDigest,rollbackImageDigest:$rollbackImageDigest,runtimeVersion:$runtimeVersion,recordDirectory:$recordDirectory}' |
  tee "${record_dir}/deployment-record.json"
