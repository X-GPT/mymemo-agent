variable "aws_region" {
  description = "AWS region for the mymemo-agent GitHub deploy role."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account ID that owns the deploy role."
  type        = string
}

variable "github_owner" {
  description = "GitHub organization or user that owns the repository."
  type        = string
  default     = "X-GPT"
}

variable "github_repository" {
  description = "GitHub repository allowed to assume this deploy role."
  type        = string
  default     = "mymemo-agent"
}

# Ref-pinned (not environment-pinned) so the release workflow needs no GitHub
# environment features, which are plan-gated on private repositories.
variable "github_deploy_ref" {
  description = "Git ref whose GitHub Actions runs are allowed to assume this deploy role."
  type        = string
  default     = "refs/heads/main"
}

variable "deploy_role_name" {
  description = "IAM role name assumed by the mymemo-agent release deploy workflow."
  type        = string
  default     = "mymemo-agent-github-actions-deploy"
}

variable "terraform_state_bucket" {
  description = "S3 bucket used by mymemo-agent Terraform state."
  type        = string
  default     = "mymemo-terraform-state-bucket"
}

variable "artifact_bucket_name" {
  description = "S3 bucket managed by the deploy role for Downloadable artifacts."
  type        = string
  default     = "mymemo-agent-prod-artifacts"
}

variable "checkpoint_bucket_name" {
  description = "S3 bucket managed by the deploy role for MicroVM Checkpoints."
  type        = string
  default     = "mymemo-agent-prod-microvm-checkpoints"
}

variable "tags" {
  description = "Tags applied to bootstrap IAM resources."
  type        = map(string)
  default = {
    Application = "mymemo-agent"
    ManagedBy   = "terraform"
  }
}
