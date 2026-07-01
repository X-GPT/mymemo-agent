output "chat_api_ecr_repository_url" {
  description = "ECR repository URL for chat-api images."
  value       = aws_ecr_repository.chat_api.repository_url
}

output "agent_worker_ecr_repository_url" {
  description = "ECR repository URL for agent-worker images."
  value       = aws_ecr_repository.agent_worker.repository_url
}
