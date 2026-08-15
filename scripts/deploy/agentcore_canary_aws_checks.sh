#!/usr/bin/env bash

verify_agentcore_canary_current_secrets() {
  local region="$1"
  local terraform_output="$2"
  local secret_arn

  while IFS= read -r secret_arn; do
    aws --profile mymemo secretsmanager list-secret-version-ids \
      --region "${region}" \
      --secret-id "${secret_arn}" \
      --include-deprecated \
      --query 'Versions[?contains(VersionStages, `AWSCURRENT`)].VersionId' \
      --output text | grep -q .
  done < <(jq -r '.runtime_secret_arns.value[]' <<<"${terraform_output}")
}

verify_agentcore_canary_alarms() {
  local region="$1"
  local terraform_output="$2"
  local alarm_names
  local alarm_count
  local expected_alarm_count

  alarm_names="$(jq -r '.alarm_names.value | join(" ")' <<<"${terraform_output}")"
  alarm_count="$(aws --profile mymemo cloudwatch describe-alarms \
    --region "${region}" \
    --alarm-names ${alarm_names} \
    --query 'MetricAlarms | length(@)' \
    --output text)"
  expected_alarm_count="$(jq '.alarm_names.value | length' <<<"${terraform_output}")"
  [[ "${alarm_count}" == "${expected_alarm_count}" ]]
}

verify_agentcore_canary_disabled_dispatch() {
  local region="$1"
  local terraform_output="$2"
  local mapping_uuid
  local repair_rule
  local enabled_parameter
  local mapping
  local consumer_function
  local consumer_configuration
  local rule

  mapping_uuid="$(jq -r '.consumer_event_source_mapping_uuid.value' <<<"${terraform_output}")"
  repair_rule="$(jq -r '.repair_rule_name.value' <<<"${terraform_output}")"
  enabled_parameter="$(jq -r '.enabled_parameter_name.value' <<<"${terraform_output}")"

  mapping="$(aws --profile mymemo lambda get-event-source-mapping \
    --region "${region}" \
    --uuid "${mapping_uuid}")"
  jq -e '.BatchSize == 1 and .State == "Disabled" and (.FunctionResponseTypes | index("ReportBatchItemFailures")) != null' <<<"${mapping}" >/dev/null
  consumer_function="$(jq -r '.FunctionArn | split(":")[-1]' <<<"${mapping}")"
  consumer_configuration="$(aws --profile mymemo lambda get-function-configuration \
    --region "${region}" \
    --function-name "${consumer_function}")"
  jq -e '.Timeout == 120' <<<"${consumer_configuration}" >/dev/null
  [[ "$(aws --profile mymemo lambda get-function-concurrency --region "${region}" --function-name "${consumer_function}" --query ReservedConcurrentExecutions --output text)" == "1" ]]

  rule="$(aws --profile mymemo events describe-rule \
    --region "${region}" \
    --name "${repair_rule}")"
  jq -e '.State == "DISABLED" and .ScheduleExpression == "rate(1 minute)"' <<<"${rule}" >/dev/null
  [[ "$(aws --profile mymemo ssm get-parameter --region "${region}" --name "${enabled_parameter}" --query Parameter.Value --output text)" == "disabled" ]]
}

verify_agentcore_canary_runtime_configuration() {
  local region="$1"
  local terraform_output="$2"
  local expected_digest="$3"
  local runtime_id
  local runtime
  local runtime_version
  local endpoint

  runtime_id="$(jq -r '.agent_runtime_id.value' <<<"${terraform_output}")"
  runtime="$(aws --profile mymemo bedrock-agentcore-control get-agent-runtime \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}")"
  jq -e --arg digest "${expected_digest}" '.status == "READY" and .metadataConfiguration.requireMMDSV2 == true and .networkConfiguration.networkMode == "VPC" and .protocolConfiguration.serverProtocol == "HTTP" and (.agentRuntimeArtifact.containerConfiguration.containerUri | endswith("@" + $digest)) and .lifecycleConfiguration.maxLifetime == 3600' <<<"${runtime}" >/dev/null
  runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
  endpoint="$(aws --profile mymemo bedrock-agentcore-control get-agent-runtime-endpoint \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}" \
    --endpoint-name DEFAULT)"
  jq -e --arg version "${runtime_version}" '.name == "DEFAULT" and .status == "READY" and .liveVersion == $version' <<<"${endpoint}" >/dev/null

  jq -n --arg runtime "${runtime}" --arg endpoint "${endpoint}" \
    '{runtime:($runtime | fromjson), endpoint:($endpoint | fromjson)}'
}

verify_agentcore_canary_consumer_runtime_authority() {
  local region="$1"
  local terraform_output="$2"
  local runtime_arn
  local endpoint_arn
  local consumer_role_arn
  local simulation

  runtime_arn="$(jq -r '.agent_runtime_arn.value' <<<"${terraform_output}")"
  endpoint_arn="${runtime_arn}/runtime-endpoint/DEFAULT"
  consumer_role_arn="$(jq -r '.consumer_role_arn.value' <<<"${terraform_output}")"
  simulation="$(aws --profile mymemo iam simulate-principal-policy \
    --policy-source-arn "${consumer_role_arn}" \
    --action-names bedrock-agentcore:InvokeAgentRuntime \
    --resource-arns "${runtime_arn}" "${endpoint_arn}")"
  jq -e '[.EvaluationResults[].EvalDecision] | length == 2 and all(. == "allowed")' <<<"${simulation}" >/dev/null
}
