output "chat_api_service_name" {
  description = "ECS service name for chat-api."
  value       = aws_ecs_service.chat_api.name
}

output "agent_worker_service_name" {
  description = "ECS service name for agent-worker."
  value       = aws_ecs_service.agent_worker.name
}

output "agent_migration_task_definition_arn" {
  description = "Task definition ARN for the agent DB migration one-shot."
  value       = aws_ecs_task_definition.agent_migration.arn
}

output "chat_api_task_definition_arn" {
  description = "Task definition ARN for the chat-api release built by Terraform."
  value       = aws_ecs_task_definition.chat_api.arn
}

output "agent_worker_task_definition_arn" {
  description = "Task definition ARN for the agent-worker release built by Terraform."
  value       = aws_ecs_task_definition.agent_worker.arn
}

output "agent_database_endpoint" {
  description = "Endpoint of the dedicated agent RDS instance."
  value       = aws_db_instance.agent.address
}

output "agent_database_password_secret_arn" {
  description = "AWS-managed Secrets Manager ARN for the dedicated agent RDS master password."
  value       = aws_db_instance.agent.master_user_secret[0].secret_arn
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
  description = "Agent ALB target group ARN for chat-api."
  value       = aws_lb_target_group.chat_api.arn
}

output "agent_alb_dns_name" {
  description = "DNS name of the agent-owned public ALB."
  value       = aws_lb.agent.dns_name
}

output "agent_alb_url" {
  description = "HTTP bootstrap URL of the agent-owned public ALB. Null when HTTPS is enabled; use the custom DNS name matching the ACM certificate instead."
  value       = var.agent_alb_certificate_arn == null ? "http://${aws_lb.agent.dns_name}" : null
}

output "shared_infra" {
  description = "Shared mymemo-service infrastructure consumed through remote state."
  value = {
    vpc_id          = local.shared_vpc_id
    ecs_subnet_ids  = local.shared_ecs_subnet_ids
    ecs_cluster_arn = local.shared_ecs_cluster_arn
  }
}
