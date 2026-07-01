variable "aws_region" {
  description = "AWS region for the mymemo-agent GitHub deploy role."
  type        = string
  default     = "us-west-2"
}

variable "aws_account_id" {
  description = "AWS account ID that owns the deploy role."
  type        = string
  default     = "637423444544"
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

variable "github_environment" {
  description = "GitHub Actions environment allowed to assume this deploy role."
  type        = string
  default     = "prod"
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

variable "tags" {
  description = "Tags applied to bootstrap IAM resources."
  type        = map(string)
  default = {
    Application = "mymemo-agent"
    ManagedBy   = "terraform"
  }
}
