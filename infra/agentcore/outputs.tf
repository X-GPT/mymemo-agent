output "runtime_repository_url" {
  description = "Immutable ECR repository used by the production AgentCore Runtime."
  value       = aws_ecr_repository.production_runtime.repository_url
}

output "runtime_image_digest" {
  description = "Exact deployed Runtime image digest."
  value       = var.runtime_image_digest
}

output "agent_runtime_id" {
  description = "Resolved native AgentCore Runtime identifier."
  value       = aws_bedrockagentcore_agent_runtime.runtime.agent_runtime_id
}

output "agent_runtime_arn" {
  description = "Resolved native AgentCore Runtime ARN."
  value       = aws_bedrockagentcore_agent_runtime.runtime.agent_runtime_arn
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
  description = "Encrypted production AgentCore dispatch queue URL."
  value       = aws_sqs_queue.dispatch.url
}

output "dispatch_queue_arn" {
  description = "Exact queue ARN expected by the consumer event-source mapping."
  value       = aws_sqs_queue.dispatch.arn
}

output "dead_letter_queue_url" {
  description = "Encrypted production AgentCore dispatch DLQ URL."
  value       = aws_sqs_queue.dead_letter.url
}

output "consumer_event_source_mapping_uuid" {
  description = "Enabled batch-size-one production consumer mapping."
  value       = aws_lambda_event_source_mapping.consumer.uuid
}

output "consumer_function_arn" {
  description = "Exact consumer Lambda ARN expected by the event-source mapping."
  value       = aws_lambda_function.consumer.arn
}

output "dispatch_enabled_parameter_name" {
  description = "Fail-closed production AgentCore dispatch parameter."
  value       = aws_ssm_parameter.dispatch_enabled.name
}

output "private_subnet_ids" {
  description = "Persistent private AgentCore subnets."
  value       = values(aws_subnet.private)[*].id
}

output "egress_configurations" {
  description = "Exact zonal NAT routes verified after deployment."
  value = {
    for availability_zone in keys(local.private_subnets) : availability_zone => {
      private_subnet_id = aws_subnet.private[availability_zone].id
      public_subnet_id  = aws_nat_gateway.egress[availability_zone].subnet_id
      route_table_id    = aws_route_table.private[availability_zone].id
      nat_gateway_id    = aws_nat_gateway.egress[availability_zone].id
    }
  }
}

output "runtime_security_group_id" {
  description = "Persistent outbound-only AgentCore Runtime security group."
  value       = aws_security_group.runtime.id
}

output "consumer_role_arn" {
  description = "Role whose invocation policy is verified against both Runtime and DEFAULT endpoint resources."
  value       = aws_iam_role.consumer.arn
}

output "runtime_secret_arns" {
  description = "Exact secret metadata inspected without reading secret values."
  value       = local.exact_secret_arns
}

output "alarm_names" {
  description = "Production AgentCore Dispatch paging alarms."
  value       = local.dispatch_alarms[*].alarm_name
}

output "alarm_configurations" {
  description = "Complete production Dispatch alarm configurations verified against the live service."
  value       = local.alarm_configurations
}
