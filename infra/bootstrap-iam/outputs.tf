output "deploy_role_arn" {
  description = "IAM role ARN assumed by the mymemo-agent release deploy workflow."
  value       = aws_iam_role.github_actions_deploy.arn
}

output "github_oidc_subject" {
  description = "GitHub OIDC subject allowed to assume the deploy role."
  value       = local.github_environment_sub
}
