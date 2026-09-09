output "kb_database_url_secret_arn" {
  description = "Secrets Manager ARN for the AgentCore Runtime KB database URL."
  value       = local.kb_database_url_secret_arn
}

output "openrouter_api_key_secret_arn" {
  description = "Secrets Manager ARN for the AgentCore Runtime OpenRouter API key."
  value       = local.openrouter_api_key_secret_arn
}

output "openrouter_base_url" {
  description = "OpenRouter base URL configured for the AgentCore Runtime."
  value       = var.openrouter_base_url
}

output "openrouter_default_model" {
  description = "Default OpenRouter model configured for the AgentCore Runtime."
  value       = var.openrouter_default_model
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
