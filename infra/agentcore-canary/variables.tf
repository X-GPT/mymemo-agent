variable "aws_region" {
  description = "AWS region containing the existing MyMemo production resources."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account that owns the canary and referenced production resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "environment" {
  description = "Deployment environment. The canary is production-only."
  type        = string
  default     = "prod"

  validation {
    condition     = var.environment == "prod"
    error_message = "The AgentCore canary may only be deployed as prod."
  }
}

variable "availability_zones" {
  description = "Two availability zones for persistent private canary subnets."
  type        = list(string)
  default     = ["us-west-2a", "us-west-2b"]

  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "Exactly two distinct availability zones are required."
  }
}

variable "private_subnet_cidrs" {
  description = "Two non-overlapping CIDRs reserved for the persistent canary private subnets."
  type        = list(string)
  default     = ["172.31.80.0/24", "172.31.81.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) == 2 && length(distinct(var.private_subnet_cidrs)) == 2
    error_message = "Exactly two distinct private subnet CIDRs are required."
  }
}

variable "campaign_network_enabled" {
  description = "Creates the campaign-scoped NAT Gateway and EIP. Must remain false for dormant deployment."
  type        = bool
  default     = false
}

variable "dispatch_enabled" {
  description = "Enables the SQS consumer and minute repair schedule. Must remain false for dormant deployment."
  type        = bool
  default     = false
}

variable "runtime_image_digest" {
  description = "Verified Linux ARM64 AgentCore Runtime image digest (sha256:...). Tags are never deployed."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.runtime_image_digest))
    error_message = "runtime_image_digest must be an exact sha256 image digest."
  }
}

variable "dispatch_lambda_package" {
  description = "Path to the verified dispatch Lambda deployment package."
  type        = string
}

variable "control_lambda_package" {
  description = "Path to the verified control Lambda deployment package."
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
  description = "Non-secret model identifier used by the canary Runtime."
  type        = string
}

variable "worker_e2b_template" {
  description = "Pinned E2B sandbox template used by the canary Runtime."
  type        = string
  default     = "mymemo-agent-sandbox"
}

variable "canary_control_config_json" {
  description = "Versioned non-secret synthetic fixture and scenario authority for the control Lambda."
  type        = string
}

variable "canary_approved_synthetic_user_id" {
  description = "Deployment-owned non-human identity accepted by the control Lambda."
  type        = string
}

variable "incident_alarm_action_arns" {
  description = "Production incident destinations for Canary safety alarms."
  type        = list(string)
  default     = []
}

variable "validation_alarm_action_arns" {
  description = "Non-paging destinations for expected Canary validation alarms."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied only to canary-owned resources."
  type        = map(string)
  default = {
    Application = "mymemo-agentcore-canary"
    Environment = "prod"
    ManagedBy   = "terraform"
  }
}
