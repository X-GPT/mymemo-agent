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
