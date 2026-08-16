#!/usr/bin/env bash
set -euo pipefail

terraform_dir="infra/agentcore-canary"
region="${AWS_REGION:?AWS_REGION is required}"
aws_profile="mymemo"
expected_digest="${EXPECTED_RUNTIME_IMAGE_DIGEST:?EXPECTED_RUNTIME_IMAGE_DIGEST is required}"
source "scripts/deploy/agentcore_canary_aws_checks.sh"

tf_output="$(terraform -chdir="${terraform_dir}" output -json)"
runtime_arn="$(jq -r '.agent_runtime_arn.value' <<<"${tf_output}")"
queue_url="$(jq -r '.dispatch_queue_url.value' <<<"${tf_output}")"
dlq_url="$(jq -r '.dead_letter_queue_url.value' <<<"${tf_output}")"

queue_attributes="$(aws --profile "${aws_profile}" sqs get-queue-attributes --region "${region}" --queue-url "${queue_url}" --attribute-names All)"
dlq_attributes="$(aws --profile "${aws_profile}" sqs get-queue-attributes --region "${region}" --queue-url "${dlq_url}" --attribute-names All)"
jq -e '(.Attributes.FifoQueue // "false") == "false" and .Attributes.VisibilityTimeout == "300" and .Attributes.MessageRetentionPeriod == "86400" and .Attributes.KmsMasterKeyId != null and .Attributes.ApproximateNumberOfMessages == "0" and .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and .Attributes.ApproximateNumberOfMessagesDelayed == "0" and (.Attributes.RedrivePolicy | fromjson | .maxReceiveCount == 3)' <<<"${queue_attributes}" >/dev/null
jq -e '(.Attributes.FifoQueue // "false") == "false" and .Attributes.VisibilityTimeout == "300" and .Attributes.MessageRetentionPeriod == "86400" and .Attributes.KmsMasterKeyId != null and .Attributes.ApproximateNumberOfMessages == "0" and .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and .Attributes.ApproximateNumberOfMessagesDelayed == "0"' <<<"${dlq_attributes}" >/dev/null

verify_agentcore_canary_disabled_dispatch "${region}" "${tf_output}"
runtime_configuration="$(verify_agentcore_canary_runtime_configuration "${region}" "${tf_output}" "${expected_digest}")"
runtime="$(jq -c '.runtime' <<<"${runtime_configuration}")"
runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
endpoint="$(jq -c '.endpoint' <<<"${runtime_configuration}")"
verify_agentcore_canary_consumer_runtime_authority "${region}" "${tf_output}"

verify_agentcore_canary_current_secrets "${region}" "${tf_output}"
verify_agentcore_canary_alarms "${region}" "${tf_output}"

rollback_digest="${ROLLBACK_RUNTIME_IMAGE_DIGEST:-}"
if [[ -n "${rollback_digest}" && "${rollback_digest}" != "${expected_digest}" ]]; then
  aws --profile "${aws_profile}" ecr describe-images --region "${region}" --repository-name mymemo/agentcore-canary-runtime --image-ids imageDigest="${rollback_digest}" --query 'imageDetails[0].imageDigest' --output text | grep -Fxq "${rollback_digest}"
fi

jq -n --arg runtimeArn "${runtime_arn}" --arg runtimeVersion "${runtime_version}" --arg endpointArn "$(jq -r '.agentRuntimeEndpointArn' <<<"${endpoint}")" --arg imageDigest "${expected_digest}" --arg rollbackDigest "${rollback_digest}" '{status:"dormant", runtimeArn:$runtimeArn, runtimeVersion:$runtimeVersion, endpointName:"DEFAULT", endpointArn:$endpointArn, imageDigest:$imageDigest, rollbackDigest:($rollbackDigest | select(length > 0)), dispatchEnabled:false, queueDepth:0, dlqDepth:0}'
