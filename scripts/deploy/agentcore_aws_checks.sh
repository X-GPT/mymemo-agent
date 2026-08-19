#!/usr/bin/env bash

verify_agentcore_current_secrets() {
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

verify_agentcore_alarms() {
  local region="$1"
  local terraform_output="$2"
  local expected_alarms
  local alarm_names
  local live_alarms

  expected_alarms="$(jq -c '.alarm_configurations.value' <<<"${terraform_output}")"
  alarm_names="$(jq -r 'keys | join(" ")' <<<"${expected_alarms}")"
  live_alarms="$(aws --profile mymemo cloudwatch describe-alarms \
    --region "${region}" \
    --alarm-names ${alarm_names})"
  jq -e --argjson expected "${expected_alarms}" '
    .MetricAlarms
    | map({
        key: .AlarmName,
        value: {
          namespace: .Namespace,
          metric_name: .MetricName,
          dimensions: ((.Dimensions // []) | map({ key: .Name, value: .Value }) | from_entries),
          statistic: .Statistic,
          period: .Period,
          evaluation_periods: .EvaluationPeriods,
          datapoints_to_alarm: .DatapointsToAlarm,
          comparison_operator: .ComparisonOperator,
          threshold: .Threshold,
          treat_missing_data: .TreatMissingData,
          actions_enabled: .ActionsEnabled,
          alarm_actions: ((.AlarmActions // []) | sort)
        }
      })
    | from_entries == $expected
  ' <<<"${live_alarms}" >/dev/null
}

verify_agentcore_idle_dispatch() {
  local region="$1"
  local terraform_output="$2"
  local mapping_uuid
  local dispatch_queue_arn
  local expected_consumer_function_arn
  local enabled_parameter
  local mapping
  local consumer_configuration
  local consumer_concurrency

  mapping_uuid="$(jq -r '.consumer_event_source_mapping_uuid.value' <<<"${terraform_output}")"
  dispatch_queue_arn="$(jq -r '.dispatch_queue_arn.value' <<<"${terraform_output}")"
  expected_consumer_function_arn="$(jq -r '.consumer_function_arn.value' <<<"${terraform_output}")"
  enabled_parameter="$(jq -r '.dispatch_enabled_parameter_name.value' <<<"${terraform_output}")"

  mapping="$(aws --profile mymemo lambda get-event-source-mapping \
    --region "${region}" \
    --uuid "${mapping_uuid}")"
  jq -e \
    --arg queueArn "${dispatch_queue_arn}" \
    --arg functionArn "${expected_consumer_function_arn}" \
    '.BatchSize == 1
      and .State == "Enabled"
      and .EventSourceArn == $queueArn
      and .FunctionArn == $functionArn
      and (.FunctionResponseTypes | index("ReportBatchItemFailures")) != null' \
    <<<"${mapping}" >/dev/null
  consumer_configuration="$(aws --profile mymemo lambda get-function-configuration \
    --region "${region}" \
    --function-name "${expected_consumer_function_arn}")"
  jq -e \
    --arg functionArn "${expected_consumer_function_arn}" \
    '.FunctionArn == $functionArn and .Timeout == 120' \
    <<<"${consumer_configuration}" >/dev/null
  consumer_concurrency="$(aws --profile mymemo lambda get-function-concurrency \
    --region "${region}" \
    --function-name "${expected_consumer_function_arn}")"
  jq -e '(.ReservedConcurrentExecutions // null) == null' \
    <<<"${consumer_concurrency}" >/dev/null
  [[ "$(aws --profile mymemo ssm get-parameter --region "${region}" --name "${enabled_parameter}" --query Parameter.Value --output text)" == "disabled" ]]
}

verify_agentcore_runtime_configuration() {
  local region="$1"
  local terraform_output="$2"
  local expected_digest="$3"
  local runtime_id
  local expected_security_configuration
  local runtime
  local runtime_version
  local endpoint

  runtime_id="$(jq -r '.agent_runtime_id.value' <<<"${terraform_output}")"
  expected_security_configuration="$(jq -c '.runtime_security_configuration.value' <<<"${terraform_output}")"
  runtime="$(aws --profile mymemo bedrock-agentcore-control get-agent-runtime \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}")"
  jq -e \
    --arg digest "${expected_digest}" \
    --argjson expected "${expected_security_configuration}" \
    '.status == "READY"
      and .roleArn == $expected.role_arn
      and .environmentVariables == $expected.environment_variables
      and .metadataConfiguration.requireMMDSV2 == true
      and .networkConfiguration.networkMode == "VPC"
      and (.networkConfiguration.networkModeConfig.subnets | sort) == $expected.subnet_ids
      and (.networkConfiguration.networkModeConfig.securityGroups | sort) == $expected.security_group_ids
      and .protocolConfiguration.serverProtocol == "HTTP"
      and (.agentRuntimeArtifact.containerConfiguration.containerUri | endswith("@" + $digest))
      and .lifecycleConfiguration.idleRuntimeSessionTimeout == $expected.idle_runtime_session_timeout
      and .lifecycleConfiguration.maxLifetime == 3600' \
    <<<"${runtime}" >/dev/null
  runtime_version="$(jq -r '.agentRuntimeVersion' <<<"${runtime}")"
  endpoint="$(aws --profile mymemo bedrock-agentcore-control get-agent-runtime-endpoint \
    --region "${region}" \
    --agent-runtime-id "${runtime_id}" \
    --endpoint-name DEFAULT)"
  jq -e --arg version "${runtime_version}" '.name == "DEFAULT" and .status == "READY" and .liveVersion == $version' <<<"${endpoint}" >/dev/null

  jq -n --arg runtime "${runtime}" --arg endpoint "${endpoint}" \
    '{runtime:($runtime | fromjson), endpoint:($endpoint | fromjson)}'
}

verify_agentcore_consumer_runtime_authority() {
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
