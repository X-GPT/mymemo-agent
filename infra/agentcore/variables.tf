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

variable "consumer_lambda_package" {
  description = "Path to the verified AgentCore dispatch consumer Lambda deployment package."
  type        = string
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
