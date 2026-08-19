variable "aws_region" {
  description = "AWS region containing the existing MyMemo production resources."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account that owns the production AgentCore and referenced MyMemo resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "environment" {
  description = "Deployment environment. This independent AgentCore stack is production-only."
  type        = string
  default     = "prod"

  validation {
    condition     = var.environment == "prod"
    error_message = "The AgentCore production stack may only be deployed as prod."
  }
}

variable "availability_zones" {
  description = "Two availability zones for persistent private AgentCore subnets."
  type        = list(string)
  default     = ["us-west-2a", "us-west-2b"]

  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "Exactly two distinct availability zones are required."
  }
}

variable "private_subnet_cidrs" {
  description = "Two non-overlapping CIDRs reserved for the persistent AgentCore private subnets."
  type        = list(string)
  default     = ["172.31.80.0/24", "172.31.81.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) == 2 && length(distinct(var.private_subnet_cidrs)) == 2
    error_message = "Exactly two distinct private subnet CIDRs are required."
  }
}

variable "runtime_image_digest" {
  description = "Verified Linux ARM64 AgentCore Runtime image digest (sha256:...). Tags are never deployed."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.runtime_image_digest))
    error_message = "runtime_image_digest must be an exact sha256 image digest."
  }
}

variable "retain_legacy_runtime_repository" {
  description = "Keeps the Terraform-managed legacy Runtime repository present only while its deployed image is copied and the production Runtime is verified."
  type        = bool
  default     = false
}

variable "consumer_lambda_package" {
  description = "Path to the verified AgentCore dispatch consumer Lambda deployment package."
  type        = string
}

variable "agent_database_url_secret_arn" {
  description = "Exact Secrets Manager ARN containing the verify-full agent database URL."
  type        = string
}

variable "kb_database_url_secret_arn" {
  description = "Exact Secrets Manager ARN containing the verify-full read-only KB database URL."
  type        = string
}

variable "openrouter_api_key_secret_arn" {
  description = "Exact Secrets Manager ARN containing the OpenRouter API key."
  type        = string
}

variable "e2b_api_key_secret_arn" {
  description = "Exact Secrets Manager ARN containing the E2B API key."
  type        = string
}

variable "redis_url_secret_arn" {
  description = "Exact Secrets Manager ARN containing the authenticated rediss URL."
  type        = string
}

variable "artifact_bucket_name" {
  description = "Existing private artifact bucket; referenced read-only by Terraform."
  type        = string
}

variable "openrouter_base_url" {
  description = "Non-secret OpenRouter base URL."
  type        = string
  default     = "https://openrouter.ai/api"
}

variable "openrouter_default_model" {
  description = "Non-secret model identifier used by the production Runtime."
  type        = string
}

variable "worker_e2b_template" {
  description = "Pinned E2B sandbox template used by the production Runtime."
  type        = string
  default     = "mymemo-agent-sandbox"
}

variable "alarm_action_arns" {
  description = "Production SNS destinations for every AgentCore Dispatch paging alarm."
  type        = list(string)

  validation {
    condition = length(var.alarm_action_arns) > 0 && alltrue([
      for arn in var.alarm_action_arns : can(regex("^arn:aws:sns:${var.aws_region}:${var.aws_account_id}:[A-Za-z0-9_-]+$", arn))
    ])
    error_message = "alarm_action_arns must contain at least one same-account, same-region SNS topic ARN."
  }
}

variable "tags" {
  description = "Tags applied only to production AgentCore-owned resources."
  type        = map(string)
  default = {
    Application = "mymemo-agentcore"
    Environment = "prod"
    ManagedBy   = "terraform"
  }
}
