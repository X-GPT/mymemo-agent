output "chat_api_ecr_repository_url" {
  description = "ECR repository URL for chat-api images."
  value       = aws_ecr_repository.chat_api.repository_url
}

output "agent_worker_ecr_repository_url" {
  description = "ECR repository URL for agent-worker images."
  value       = aws_ecr_repository.agent_worker.repository_url
}

output "agent_maintenance_ecr_repository_url" {
  description = "ECR repository URL for agent-maintenance images."
  value       = aws_ecr_repository.agent_maintenance.repository_url
}

output "agentcore_dispatch_publisher_ecr_repository_url" {
  description = "ECR repository URL for AgentCore dispatch publisher images."
  value       = aws_ecr_repository.agentcore_dispatch_publisher.repository_url
}

output "agentcore_runtime_ecr_repository_url" {
  description = "ECR repository URL for AgentCore Runtime images."
  value       = aws_ecr_repository.agentcore_runtime.repository_url
}
