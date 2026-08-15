#!/usr/bin/env bash
set -euo pipefail

terraform_dir="infra/agentcore-canary"
region="${AWS_REGION:?AWS_REGION is required}"
aws_profile="${AWS_PROFILE:-mymemo}"
expected_digest="${EXPECTED_RUNTIME_IMAGE_DIGEST:?EXPECTED_RUNTIME_IMAGE_DIGEST is required}"

tf_output="$(terraform -chdir="${terraform_dir}" output -json)"
runtime_id="$(jq -r '.agent_runtime_id.value' <<<"${tf_output}")"
runtime_arn="$(jq -r '.agent_runtime_arn.value' <<<"${tf_output}")"
queue_url="$(jq -r '.dispatch_queue_url.value' <<<"${tf_output}")"
dlq_url="$(jq -r '.dead_letter_queue_url.value' <<<"${tf_output}")"
mapping_uuid="$(jq -r '.consumer_event_source_mapping_uuid.value' <<<"${tf_output}")"
repair_rule="$(jq -r '.repair_rule_name.value' <<<"${tf_output}")"
enabled_parameter="$(jq -r '.enabled_parameter_name.value' <<<"${tf_output}")"
consumer_role_arn="$(jq -r '.consumer_role_arn.value' <<<"${tf_output}")"

[[ "$(jq '.campaign_nat_gateway_ids.value | length' <<<"${tf_output}")" == "0" ]]
[[ "$(jq '.campaign_eip_allocation_ids.value | length' <<<"${tf_output}")" == "0" ]]
nat_count="$(aws --profile "${aws_profile}" ec2 describe-nat-gateways --region "${region}" --filter Name=tag:Application,Values=mymemo-agentcore-canary Name=state,Values=pending,available --query 'NatGateways | length(@)' --output text)"
eip_count="$(aws --profile "${aws_profile}" ec2 describe-addresses --region "${region}" --filters Name=tag:Application,Values=mymemo-agentcore-canary --query 'Addresses | length(@)' --output text)"
[[ "${nat_count}" == "0" ]]
[[ "${eip_count}" == "0" ]]

queue_attributes="$(aws --profile "${aws_profile}" sqs get-queue-attributes --region "${region}" --queue-url "${queue_url}" --attribute-names All)"
dlq_attributes="$(aws --profile "${aws_profile}" sqs get-queue-attributes --region "${region}" --queue-url "${dlq_url}" --attribute-names All)"
jq -e '(.Attributes.FifoQueue // "false") == "false" and .Attributes.VisibilityTimeout == "300" and .Attributes.MessageRetentionPeriod == "86400" and .Attributes.KmsMasterKeyId != null and .Attributes.ApproximateNumberOfMessages == "0" and .Attributes.ApproximateNumberOfMessagesNotVisible == "0" and (.Attributes.RedrivePolicy | fromjson | .maxReceiveCount == 3)' <<<"${queue_attributes}" >/dev/null
jq -e '(.Attributes.FifoQueue // "false") == "false" and .Attributes.VisibilityTimeout == "300" and .Attributes.MessageRetentionPeriod == "86400" and .Attributes.KmsMasterKeyId != null and .Attributes.ApproximateNumberOfMessages == "0" and .Attributes.ApproximateNumberOfMessagesNotVisible == "0"' <<<"${dlq_attributes}" >/dev/null

mapping="$(aws --profile "${aws_profile}" lambda get-event-source-mapping --region "${region}" --uuid "${mapping_uuid}")"
jq -e '.BatchSize == 1 and .State == "Disabled" and (.FunctionResponseTypes | index("ReportBatchItemFailures")) != null' <<<"${mapping}" >/dev/null
consumer_function="$(jq -r '.FunctionArn | split(":")[-1]' <<<"${mapping}")"
consumer_configuration="$(aws --profile "${aws_profile}" lambda get-function-configuration --region "${region}" --function-name "${consumer_function}")"
jq -e '.Timeout == 120' <<<"${consumer_configuration}" >/dev/null
[[ "$(aws --profile "${aws_profile}" lambda get-function-concurrency --region "${region}" --function-name "${consumer_function}" --query ReservedConcurrentExecutions --output text)" == "1" ]]

rule="$(aws --profile "${aws_profile}" events describe-rule --region "${region}" --name "${repair_rule}")"
jq -e '.State == "DISABLED" and .ScheduleExpression == "rate(1 minute)"' <<<"${rule}" >/dev/null
[[ "$(aws --profile "${aws_profile}" ssm get-parameter --region "${region}" --name "${enabled_parameter}" --query Parameter.Value --output text)" == "disabled" ]]

runtime="$(aws --profile "${aws_profile}" bedrock-agentcore-control get-agent-runtime --region "${region}" --agent-runtime-id "${runtime_id}")"
jq -e --arg digest "${expected_digest}" '.status == "READY" and .metadataConfiguration.requireMMDSV2 == true and .networkConfiguration.networkMode == "VPC" and .protocolConfiguration.serverProtocol == "HTTP" and (.agentRuntimeArtifact.containerConfiguration.containerUri | endswith("@" + $digest)) and .lifecycleConfiguration.maxLifetime == 3600' <<<"${runtime}" >/dev/null
runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
endpoint="$(aws --profile "${aws_profile}" bedrock-agentcore-control get-agent-runtime-endpoint --region "${region}" --agent-runtime-id "${runtime_id}" --endpoint-name DEFAULT)"
jq -e --arg version "${runtime_version}" '.name == "DEFAULT" and .status == "READY" and .liveVersion == $version' <<<"${endpoint}" >/dev/null
endpoint_arn="${runtime_arn}/runtime-endpoint/DEFAULT"

simulation="$(aws --profile "${aws_profile}" iam simulate-principal-policy --policy-source-arn "${consumer_role_arn}" --action-names bedrock-agentcore:InvokeAgentRuntime --resource-arns "${runtime_arn}" "${endpoint_arn}")"
jq -e '[.EvaluationResults[].EvalDecision] | length == 2 and all(. == "allowed")' <<<"${simulation}" >/dev/null

for secret_arn in $(jq -r '.runtime_secret_arns.value[]' <<<"${tf_output}"); do
  aws --profile "${aws_profile}" secretsmanager list-secret-version-ids --region "${region}" --secret-id "${secret_arn}" --include-deprecated --query 'Versions[?contains(VersionStages, `AWSCURRENT`)].VersionId' --output text | grep -q .
done

alarm_names="$(jq -r '.alarm_names.value | join(" ")' <<<"${tf_output}")"
alarm_count="$(aws --profile "${aws_profile}" cloudwatch describe-alarms --region "${region}" --alarm-names ${alarm_names} --query 'MetricAlarms | length(@)' --output text)"
[[ "${alarm_count}" == "$(jq '.alarm_names.value | length' <<<"${tf_output}")" ]]

end_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
start_time="$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
# AWS publishes ActiveSessionCount once per account/region/service and exposes no
# Runtime dimension. Zero is therefore a stronger account-wide dormancy proof;
# a future second Runtime will make this check fail closed rather than hide work.
active_sessions="$(aws --profile "${aws_profile}" cloudwatch get-metric-statistics --region "${region}" --namespace AWS/Bedrock-AgentCore --metric-name ActiveSessionCount --dimensions Name=Service,Value=AgentCore.Runtime --statistics Maximum --period 60 --start-time "${start_time}" --end-time "${end_time}")"
jq -e '([.Datapoints[].Maximum] | max // 0) == 0' <<<"${active_sessions}" >/dev/null

rollback_digest="${ROLLBACK_RUNTIME_IMAGE_DIGEST:-}"
if [[ -n "${rollback_digest}" && "${rollback_digest}" != "${expected_digest}" ]]; then
  aws --profile "${aws_profile}" ecr describe-images --region "${region}" --repository-name mymemo/agentcore-canary-runtime --image-ids imageDigest="${rollback_digest}" --query 'imageDetails[0].imageDigest' --output text | grep -Fxq "${rollback_digest}"
fi

jq -n --arg runtimeArn "${runtime_arn}" --arg runtimeVersion "${runtime_version}" --arg endpointArn "$(jq -r '.agentRuntimeEndpointArn' <<<"${endpoint}")" --arg imageDigest "${expected_digest}" --arg rollbackDigest "${rollback_digest}" '{status:"dormant", runtimeArn:$runtimeArn, runtimeVersion:$runtimeVersion, endpointName:"DEFAULT", endpointArn:$endpointArn, imageDigest:$imageDigest, rollbackDigest:($rollbackDigest | select(length > 0)), dispatchEnabled:false, queueDepth:0, dlqDepth:0, accountActiveRuntimeSessions:0, activeRuntimeSessionsScope:"account-region-service", natGatewayCount:0, eipCount:0}'
