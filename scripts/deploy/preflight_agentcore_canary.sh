#!/usr/bin/env bash
set -euo pipefail

terraform_dir="infra/agentcore-canary"
region="${AWS_REGION:?AWS_REGION is required}"
aws_profile="${AWS_PROFILE:-mymemo}"
rollback_digest="${ROLLBACK_RUNTIME_IMAGE_DIGEST:?ROLLBACK_RUNTIME_IMAGE_DIGEST is required}"

tf_output="$(terraform -chdir="${terraform_dir}" output -json)"
runtime_arn="$(jq -r '.agent_runtime_arn.value' <<<"${tf_output}")"
preflight_function="$(jq -r '.preflight_function_name.value' <<<"${tf_output}")"
fault_role_arn="$(jq -r '.fault_injection_role_arn.value' <<<"${tf_output}")"
queue_url="$(jq -r '.dispatch_queue_url.value' <<<"${tf_output}")"
dlq_url="$(jq -r '.dead_letter_queue_url.value' <<<"${tf_output}")"

# This connectivity check runs only in an explicitly opened campaign network
# window. It is not part of the dormant deployment, where both lists are empty.
[[ "$(jq '.campaign_nat_gateway_ids.value | length' <<<"${tf_output}")" == "1" ]]
[[ "$(jq '.campaign_eip_allocation_ids.value | length' <<<"${tf_output}")" == "1" ]]

response_file="$(mktemp /tmp/mymemo-agentcore-preflight.XXXXXX)"
trap 'rm -f "${response_file}"' EXIT
invocation="$(aws --profile "${aws_profile}" lambda invoke --region "${region}" --function-name "${preflight_function}" --payload '{}' --cli-binary-format raw-in-base64-out "${response_file}")"
jq -e '.FunctionError == null' <<<"${invocation}" >/dev/null
jq -e '.health == "ok" and .agentDatabaseTls == true and .kbDatabaseTls == true and .runAdmitted == false' "${response_file}" >/dev/null

for queue in "${queue_url}" "${dlq_url}"; do
  attributes="$(aws --profile "${aws_profile}" sqs get-queue-attributes --region "${region}" --queue-url "${queue}" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible)"
  jq -e '.Attributes.ApproximateNumberOfMessages == "0" and .Attributes.ApproximateNumberOfMessagesNotVisible == "0"' <<<"${attributes}" >/dev/null
done

for secret_arn in $(jq -r '.runtime_secret_arns.value[]' <<<"${tf_output}"); do
  aws --profile "${aws_profile}" secretsmanager list-secret-version-ids --region "${region}" --secret-id "${secret_arn}" --query 'Versions[?contains(VersionStages, `AWSCURRENT`)].VersionId' --output text | grep -q .
done

alarm_names="$(jq -r '.alarm_names.value | join(" ")' <<<"${tf_output}")"
alarm_count="$(aws --profile "${aws_profile}" cloudwatch describe-alarms --region "${region}" --alarm-names ${alarm_names} --query 'MetricAlarms | length(@)' --output text)"
[[ "${alarm_count}" == "$(jq '.alarm_names.value | length' <<<"${tf_output}")" ]]

aws --profile "${aws_profile}" ecr describe-images --region "${region}" --repository-name mymemo/agentcore-canary-runtime --image-ids imageDigest="${rollback_digest}" --query 'imageDetails[0].imageDigest' --output text | grep -Fxq "${rollback_digest}"

endpoint_arn="${runtime_arn}/runtime-endpoint/DEFAULT"
cleanup_simulation="$(aws --profile "${aws_profile}" iam simulate-principal-policy --policy-source-arn "${fault_role_arn}" --action-names bedrock-agentcore:StopRuntimeSession --resource-arns "${runtime_arn}" "${endpoint_arn}")"
jq -e '[.EvaluationResults[].EvalDecision] | length == 2 and all(. == "allowed")' <<<"${cleanup_simulation}" >/dev/null

jq -n --arg rollbackDigest "${rollback_digest}" '{health:"ok", verifiedTls:true, runAdmitted:false, queueDepth:0, dlqDepth:0, rollbackDigest:$rollbackDigest, cleanupAuthority:true}'
