#!/usr/bin/env bash
set -euo pipefail

terraform_dir="infra/terraform"
region="${AWS_REGION:?AWS_REGION is required}"
evidence_path="${1:-}"
runtime_output="${2:-agent_runtime_id}"
source "scripts/deploy/agentcore_aws_checks.sh"

runtime_id="$(terraform -chdir="${terraform_dir}" output -raw "${runtime_output}")"
runtime="$(agentcore_aws bedrock-agentcore-control get-agent-runtime \
  --region "${region}" \
  --agent-runtime-id "${runtime_id}")"

# hashicorp/aws 6.x does not expose metadataConfiguration on the native
# AgentCore Runtime resource. Preserve the declared Runtime configuration while
# setting the service-mandated MMDSv2 flag through the control-plane API.
if ! jq -e '.metadataConfiguration.requireMMDSV2 == true' <<<"${runtime}" >/dev/null; then
  update_input="$(mktemp /tmp/mymemo-agentcore-mmdsv2.XXXXXX.json)"
  trap 'rm -f "${update_input}"' EXIT
  jq '{
    agentRuntimeId,
    agentRuntimeArtifact,
    roleArn,
    networkConfiguration: (
      if .networkConfiguration.networkMode == "VPC" then {
        networkMode: "VPC",
        networkModeConfig: {
          securityGroups: .networkConfiguration.networkModeConfig.securityGroups,
          subnets: .networkConfiguration.networkModeConfig.subnets
        }
      } else {
        networkMode: .networkConfiguration.networkMode
      } end
    ),
    description,
    protocolConfiguration,
    lifecycleConfiguration,
    environmentVariables,
    authorizerConfiguration,
    requestHeaderConfiguration,
    filesystemConfigurations,
    metadataConfiguration: {requireMMDSV2: true}
  } | with_entries(select(.value != null))' <<<"${runtime}" >"${update_input}"
  agentcore_aws bedrock-agentcore-control update-agent-runtime \
    --region "${region}" \
    --cli-input-json "file://${update_input}" >/dev/null
fi

runtime_status=""
for _ in $(seq 1 60); do
  runtime_status="$(agentcore_aws bedrock-agentcore-control get-agent-runtime \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}" \
    --query status \
    --output text)"
  [[ "${runtime_status}" == "READY" ]] && break
  [[ "${runtime_status}" == "CREATE_FAILED" || "${runtime_status}" == "UPDATE_FAILED" ]] && exit 1
  sleep 10
done
[[ "${runtime_status}" == "READY" ]]

endpoint_status=""
for _ in $(seq 1 60); do
  endpoint_status="$(agentcore_aws bedrock-agentcore-control get-agent-runtime-endpoint \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}" \
    --endpoint-name DEFAULT \
    --query status \
    --output text)"
  [[ "${endpoint_status}" == "READY" ]] && break
  [[ "${endpoint_status}" == "CREATE_FAILED" || "${endpoint_status}" == "UPDATE_FAILED" ]] && exit 1
  sleep 10
done
[[ "${endpoint_status}" == "READY" ]]

runtime="$(agentcore_aws bedrock-agentcore-control get-agent-runtime \
  --region "${region}" \
  --agent-runtime-id "${runtime_id}")"
jq -e '.metadataConfiguration.requireMMDSV2 == true' <<<"${runtime}" >/dev/null
runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
endpoint="$(agentcore_aws bedrock-agentcore-control get-agent-runtime-endpoint \
  --region "${region}" \
  --agent-runtime-id "${runtime_id}" \
  --endpoint-name DEFAULT)"
jq -e --arg version "${runtime_version}" \
  '.name == "DEFAULT" and .status == "READY" and .liveVersion == $version' \
  <<<"${endpoint}" >/dev/null

evidence="$(jq -n \
  --argjson runtime "${runtime}" \
  --argjson endpoint "${endpoint}" \
  '{runtime:$runtime,endpoint:$endpoint}')"
if [[ -n "${evidence_path}" ]]; then
  mkdir -p "$(dirname "${evidence_path}")"
  printf '%s\n' "${evidence}" >"${evidence_path}"
else
  printf '%s\n' "${evidence}"
fi
