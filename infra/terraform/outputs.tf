output "chat_api_service_name" {
  description = "ECS service name for chat-api."
  value       = aws_ecs_service.chat_api.name
}

output "agent_maintenance_service_name" {
  description = "ECS service name for agent-maintenance."
  value       = aws_ecs_service.agent_maintenance.name
}

output "agentcore_dispatch_publisher_service_name" {
  description = "ECS service name for the AgentCore dispatch publisher."
  value       = aws_ecs_service.agentcore_dispatch_publisher.name
}

output "agent_migration_task_definition_arn" {
  description = "Task definition ARN for the agent DB migration one-shot."
  value       = aws_ecs_task_definition.agent_migration.arn
}

output "chat_api_task_definition_arn" {
  description = "Task definition ARN for the chat-api release built by Terraform."
  value       = aws_ecs_task_definition.chat_api.arn
}

output "agent_maintenance_task_definition_arn" {
  description = "Task definition ARN for the agent-maintenance release built by Terraform."
  value       = aws_ecs_task_definition.agent_maintenance.arn
}

output "agentcore_dispatch_publisher_task_definition_arn" {
  description = "Task definition ARN for the AgentCore dispatch publisher release built by Terraform."
  value       = aws_ecs_task_definition.agentcore_dispatch_publisher.arn
}

output "agent_database_endpoint" {
  description = "Endpoint of the dedicated agent RDS instance."
  value       = aws_db_instance.agent.address
}

output "agent_database_url" {
  description = "Passwordless writable agent database URL."
  value       = local.managed_agent_database_url
}

output "agent_database_password_secret_arn" {
  description = "AWS-managed Secrets Manager ARN for the dedicated agent RDS master password."
  value       = aws_db_instance.agent.master_user_secret[0].secret_arn
}

output "kb_database_url_secret_arn" {
  description = "Secrets Manager ARN for the AgentCore Runtime KB database URL."
  value       = local.kb_database_url_secret_arn
}

output "openrouter_api_key_secret_arn" {
  description = "Secrets Manager ARN for the AgentCore Runtime OpenRouter API key."
  value       = local.openrouter_api_key_secret_arn
}

output "e2b_api_key_secret_arn" {
  description = "Secrets Manager ARN for the E2B API key."
  value       = local.e2b_api_key_secret_arn
}

output "redis_url_secret_arn" {
  description = "Secrets Manager ARN for the Redis URL."
  value       = local.live_redis_url_secret_arn
}

output "openrouter_base_url" {
  description = "OpenRouter base URL configured for the AgentCore Runtime."
  value       = var.openrouter_base_url
}

output "openrouter_default_model" {
  description = "Default OpenRouter model configured for the AgentCore Runtime."
  value       = var.openrouter_default_model
}

output "worker_e2b_template" {
  description = "E2B template configured for the AgentCore Runtime."
  value       = var.worker_e2b_template
}

output "artifact_bucket_name" {
  description = "Artifact bucket configured for trusted services."
  value       = aws_s3_bucket.artifacts.bucket
}

output "alarm_action_arns" {
  description = "Alarm notification destinations configured for agent services."
  value       = var.alarm_action_arns
}

output "database_access_endpoint_id" {
  description = "EC2 Instance Connect Endpoint ID for operator access to the agent and KB databases."
  value       = aws_ec2_instance_connect_endpoint.database_access.id
}

output "database_access_endpoint_dns_name" {
  description = "DNS name of the EC2 Instance Connect Endpoint for operator database access."
  value       = aws_ec2_instance_connect_endpoint.database_access.dns_name
}

output "database_access_bridge_instance_id" {
  description = "Private EC2 instance used for SSH local forwarding to the agent and KB databases."
  value       = aws_instance.database_bridge.id
}

output "service_security_group_id" {
  description = "Security group attached to the agent ECS services."
  value       = aws_security_group.services.id
}

output "shared_ecs_cluster_arn" {
  description = "Shared mymemo-service ECS cluster ARN consumed by agent deploy scripts."
  value       = local.shared_ecs_cluster_arn
}

output "shared_ecs_subnet_ids" {
  description = "Shared mymemo-service ECS subnet IDs consumed by agent deploy scripts."
  value       = local.shared_ecs_subnet_ids
}

output "assign_public_ip" {
  description = "Whether ECS tasks should receive public IPs in the inherited shared subnet layout."
  value       = var.assign_public_ip
}

output "chat_api_target_group_arn" {
  description = "Internal agent ALB target group ARN for chat-api."
  value       = aws_lb_target_group.chat_api.arn
}

output "chat_api_service_connect_namespace_arn" {
  description = "Service Connect namespace ARN for the later mymemo-service client configuration."
  value       = aws_service_discovery_http_namespace.services.arn
}

output "chat_api_service_connect_endpoint" {
  description = "Internal Service Connect endpoint for later mymemo-service adoption."
  value       = "http://${local.chat_api_service_connect_dns_name}:${var.chat_api_port}"
}

output "agent_internal_alb_dns_name" {
  description = "DNS name of the agent-owned internal ALB."
  value       = aws_lb.agent.dns_name
}

output "agent_internal_base_url" {
  description = "Internal base URL for mymemo-service to call mymemo-agent chat-api."
  value       = "http://${aws_lb.agent.dns_name}"
}

output "agent_internal_allowed_caller_security_group_ids" {
  description = "Trusted caller security group IDs allowed to call chat-api through the internal ALB or Service Connect."
  value       = local.trusted_caller_security_group_ids
}

output "shared_infra" {
  description = "Shared mymemo-service infrastructure consumed through remote state."
  value = {
    vpc_id          = local.shared_vpc_id
    ecs_subnet_ids  = local.shared_ecs_subnet_ids
    ecs_cluster_arn = local.shared_ecs_cluster_arn
  }
}
