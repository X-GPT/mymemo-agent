#!/usr/bin/env bash
set -euo pipefail

terraform_dir="infra/terraform"
region="${AWS_REGION:?AWS_REGION is required}"
expected_digest="${EXPECTED_RUNTIME_IMAGE_DIGEST:?EXPECTED_RUNTIME_IMAGE_DIGEST is required}"
expected_dispatch_value="${EXPECTED_DISPATCH_VALUE:?EXPECTED_DISPATCH_VALUE is required}"
source "scripts/deploy/agentcore_aws_checks.sh"

tf_output="$(terraform -chdir="${terraform_dir}" output -json)"
runtime_arn="$(jq -r '.agent_runtime_arn.value' <<<"${tf_output}")"
queue_url="$(jq -r '.dispatch_queue_url.value' <<<"${tf_output}")"
dlq_url="$(jq -r '.dead_letter_queue_url.value' <<<"${tf_output}")"

queue_attributes="$(agentcore_aws sqs get-queue-attributes --region "${region}" --queue-url "${queue_url}" --attribute-names All)"
dlq_attributes="$(agentcore_aws sqs get-queue-attributes --region "${region}" --queue-url "${dlq_url}" --attribute-names All)"
jq -e '(.Attributes.FifoQueue // "false") == "false" and .Attributes.VisibilityTimeout == "180" and .Attributes.MessageRetentionPeriod == "86400" and .Attributes.KmsMasterKeyId != null and (.Attributes.RedrivePolicy | fromjson | .maxReceiveCount == 5)' <<<"${queue_attributes}" >/dev/null
jq -e '(.Attributes.FifoQueue // "false") == "false" and .Attributes.VisibilityTimeout == "300" and .Attributes.MessageRetentionPeriod == "86400" and .Attributes.KmsMasterKeyId != null' <<<"${dlq_attributes}" >/dev/null
queue_depth="$(jq -r '.Attributes.ApproximateNumberOfMessages | tonumber' <<<"${queue_attributes}")"
queue_in_flight="$(jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible | tonumber' <<<"${queue_attributes}")"
queue_delayed="$(jq -r '.Attributes.ApproximateNumberOfMessagesDelayed | tonumber' <<<"${queue_attributes}")"
dlq_depth="$(jq -r '.Attributes.ApproximateNumberOfMessages | tonumber' <<<"${dlq_attributes}")"

verify_agentcore_egress "${region}" "${tf_output}"
verify_agentcore_dispatch_wiring "${region}" "${tf_output}" "${expected_dispatch_value}"
runtime_configuration="$(verify_agentcore_runtime_configuration "${region}" "${tf_output}" "${expected_digest}")"
runtime="$(jq -c '.runtime' <<<"${runtime_configuration}")"
runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
endpoint="$(jq -c '.endpoint' <<<"${runtime_configuration}")"
verify_agentcore_consumer_runtime_authority "${region}" "${tf_output}"

verify_agentcore_current_secrets "${region}" "${tf_output}"
verify_agentcore_alarms "${region}" "${tf_output}"

dispatch_enabled=false
[[ "${expected_dispatch_value}" == "enabled" ]] && dispatch_enabled=true

jq -n --arg runtimeArn "${runtime_arn}" --arg runtimeVersion "${runtime_version}" --arg endpointArn "$(jq -r '.agentRuntimeEndpointArn' <<<"${endpoint}")" --arg imageDigest "${expected_digest}" --arg dispatchValue "${expected_dispatch_value}" --argjson dispatchEnabled "${dispatch_enabled}" --argjson queueDepth "${queue_depth}" --argjson queueInFlight "${queue_in_flight}" --argjson queueDelayed "${queue_delayed}" --argjson dlqDepth "${dlq_depth}" '{status:"ready", runtimeArn:$runtimeArn, runtimeVersion:$runtimeVersion, endpointName:"DEFAULT", endpointArn:$endpointArn, imageDigest:$imageDigest, dispatchValue:$dispatchValue, dispatchEnabled:$dispatchEnabled, consumerEnabled:true, queueDepth:$queueDepth, queueInFlight:$queueInFlight, queueDelayed:$queueDelayed, dlqDepth:$dlqDepth}'
