variable "aws_region" {
  description = "AWS region for the existing MyMemo environment."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account that owns the production MyMemo resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "environment" {
  description = "Deployment environment name, for namespacing resources."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for agent-owned AWS resources."
  type        = string
  default     = "mymemo-agent"
}

variable "tags" {
  description = "Tags applied to all agent-owned resources."
  type        = map(string)
  default     = {}
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

variable "fck_nat_ami_id" {
  description = "Reviewed immutable ARM64 fck-nat AMI ID for the deployment region."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]+$", var.fck_nat_ami_id))
    error_message = "fck_nat_ami_id must be an exact EC2 AMI ID."
  }
}

variable "kb_database_security_group_id" {
  description = "Security group ID of the existing mymemo-service RDS instance hosting the KB database. Owned by the mymemo-service stack; this stack attaches AgentCore Runtime ingress."
  type        = string

  validation {
    condition     = length(var.kb_database_security_group_id) > 0
    error_message = "The KB database security group ID is required."
  }
}

variable "alarm_action_arns" {
  description = "SNS topic ARNs notified by Runtime and front CloudWatch alarms."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch log retention for agent services."
  type        = number
  default     = 30
}

variable "openrouter_base_url" {
  description = "OpenRouter base URL used by the AgentCore Runtime."
  type        = string
  default     = "https://openrouter.ai/api"
}

variable "openrouter_default_model" {
  description = "Default OpenRouter model used by the AgentCore Runtime."
  type        = string
}

variable "kb_database_url_secret_name" {
  description = "Secrets Manager secret name containing the AgentCore Runtime KB_DATABASE_URL. Defaults to <name_prefix>-<environment>-KB_DATABASE_URL."
  type        = string
  default     = null
}

variable "exposure_gate_mode" {
  description = "Front exposure gate: \"statsig\" evaluates the Statsig gate, \"open\" admits every identity (the Agent is generally available and admission is decided by credit upstream)."
  type        = string
  default     = "statsig"
  validation {
    condition     = contains(["statsig", "open"], var.exposure_gate_mode)
    error_message = "exposure_gate_mode must be \"statsig\" or \"open\"."
  }
}

variable "statsig_server_secret_name" {
  description = "Secrets Manager secret name containing STATSIG_SERVER_SECRET. Defaults to <name_prefix>-<environment>-STATSIG_SERVER_SECRET."
  type        = string
  default     = null
}

variable "openrouter_api_key_secret_name" {
  description = "Secrets Manager secret name containing OPENROUTER_API_KEY. Defaults to <name_prefix>-<environment>-OPENROUTER_API_KEY."
  type        = string
  default     = null
}

variable "front_lambda_package" {
  description = "Path to the Linux ARM64 front Lambda zip built by release-deploy."
  type        = string
}

variable "mymemo_service_task_role_arn" {
  description = "Existing mymemo-service task role allowed to sign front Function URL requests."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/.+$", var.mymemo_service_task_role_arn))
    error_message = "An IAM role ARN is required."
  }
}
