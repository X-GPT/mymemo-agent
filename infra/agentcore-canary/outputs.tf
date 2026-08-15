output "runtime_repository_url" {
  description = "Immutable ECR repository used only by the AgentCore canary Runtime."
  value       = aws_ecr_repository.runtime.repository_url
}

output "runtime_image_digest" {
  description = "Exact deployed Runtime image digest."
  value       = var.runtime_image_digest
}

output "agent_runtime_id" {
  description = "Resolved native AgentCore Runtime identifier."
  value       = aws_bedrockagentcore_agent_runtime.canary.agent_runtime_id
}

output "agent_runtime_arn" {
  description = "Resolved native AgentCore Runtime ARN."
  value       = aws_bedrockagentcore_agent_runtime.canary.agent_runtime_arn
}

output "runtime_security_configuration" {
  description = "Exact non-secret Runtime security configuration verified against the live service."
  value = {
    role_arn                     = aws_iam_role.runtime.arn
    environment_variables        = local.runtime_environment
    subnet_ids                   = sort(values(aws_subnet.private)[*].id)
    security_group_ids           = sort(local.runtime_security_group_ids)
    idle_runtime_session_timeout = 900
  }
}

output "default_endpoint_name" {
  description = "Service-owned endpoint automatically created and advanced with the Runtime."
  value       = "DEFAULT"
}

output "dispatch_queue_url" {
  description = "Dormant encrypted standard canary queue URL."
  value       = aws_sqs_queue.dispatch.url
}

output "dispatch_queue_arn" {
  description = "Exact queue ARN expected by the consumer event-source mapping."
  value       = aws_sqs_queue.dispatch.arn
}

output "dead_letter_queue_url" {
  description = "Dormant encrypted canary DLQ URL."
  value       = aws_sqs_queue.dead_letter.url
}

output "consumer_event_source_mapping_uuid" {
  description = "Disabled batch-size-one consumer mapping."
  value       = aws_lambda_event_source_mapping.consumer.uuid
}

output "consumer_function_arn" {
  description = "Exact consumer Lambda ARN expected by the event-source mapping."
  value       = aws_lambda_function.consumer.arn
}

output "repair_rule_name" {
  description = "Disabled one-minute repair schedule."
  value       = aws_cloudwatch_event_rule.repair.name
}

output "repair_rule_arn" {
  description = "Exact repair rule ARN expected by the publisher permission."
  value       = aws_cloudwatch_event_rule.repair.arn
}

output "publisher_function_arn" {
  description = "Exact publisher Lambda ARN expected by the repair target."
  value       = aws_lambda_function.publisher.arn
}

output "enabled_parameter_name" {
  description = "Fail-closed canary control parameter."
  value       = aws_ssm_parameter.enabled.name
}

output "private_subnet_ids" {
  description = "Persistent private canary subnets."
  value       = values(aws_subnet.private)[*].id
}

output "canary_security_group_id" {
  description = "Persistent outbound-only canary security group."
  value       = aws_security_group.canary.id
}

output "campaign_nat_gateway_ids" {
  description = "Empty while dormant; one ID only during an approved campaign."
  value       = aws_nat_gateway.campaign[*].id
}

output "campaign_eip_allocation_ids" {
  description = "Empty while dormant; one allocation only during an approved campaign."
  value       = aws_eip.campaign[*].allocation_id
}

output "control_function_name" {
  description = "Operator-only canary control Lambda."
  value       = aws_lambda_function.control.function_name
}

output "preflight_function_name" {
  description = "Connectivity-only Lambda that cannot admit a Run."
  value       = aws_lambda_function.preflight.function_name
}

output "consumer_role_arn" {
  description = "Role whose invocation policy is verified against both Runtime and DEFAULT endpoint resources."
  value       = aws_iam_role.consumer.arn
}

output "fault_injection_role_arn" {
  description = "Role whose scoped cleanup authority is verified during preflight."
  value       = aws_iam_role.fault_injection.arn
}

output "runtime_secret_arns" {
  description = "Exact secret metadata inspected without reading secret values."
  value       = local.exact_secret_arns
}

output "alarm_names" {
  description = "Low-cardinality safety and validation alarms required by preflight."
  value = concat(
    [
      aws_cloudwatch_metric_alarm.dispatch_age.alarm_name,
      aws_cloudwatch_metric_alarm.dead_letter_work.alarm_name,
      aws_cloudwatch_metric_alarm.consumer_duration.alarm_name,
      aws_cloudwatch_metric_alarm.dormant_runtime_sessions.alarm_name,
    ],
    values(aws_cloudwatch_metric_alarm.lambda_errors)[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.lambda_throttles)[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.incident)[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.validation)[*].alarm_name,
  )
}

output "deployment_role_arn" {
  description = "Main-bound GitHub OIDC role for independent manual image promotion."
  value       = aws_iam_role.deployment.arn
}
