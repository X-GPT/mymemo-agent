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

variable "mymemo_service_api_security_group_ids" {
  description = "Security group IDs for mymemo-service API tasks allowed to call the internal agent ALB."
  type        = list(string)

  validation {
    condition     = length(var.mymemo_service_api_security_group_ids) > 0
    error_message = "At least one mymemo-service API security group ID is required."
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

variable "chat_api_image" {
  description = "Fully qualified chat-api container image URI including tag."
  type        = string

  validation {
    condition     = length(var.chat_api_image) > 0
    error_message = "chat_api_image is required."
  }
}

variable "agent_maintenance_image" {
  description = "Fully qualified agent-maintenance container image URI including tag."
  type        = string

  validation {
    condition     = length(var.agent_maintenance_image) > 0
    error_message = "agent_maintenance_image is required."
  }
}

variable "agentcore_dispatch_publisher_image" {
  description = "Fully qualified AgentCore dispatch publisher container image URI including tag."
  type        = string

  validation {
    condition     = length(var.agentcore_dispatch_publisher_image) > 0
    error_message = "agentcore_dispatch_publisher_image is required."
  }
}

variable "chat_api_desired_count" {
  description = "Desired ECS task count for chat-api."
  type        = number
  default     = 1
}

variable "agent_maintenance_desired_count" {
  description = "Desired ECS task count for the singleton agent-maintenance owner."
  type        = number
  default     = 1

  validation {
    condition     = var.agent_maintenance_desired_count == 0 || var.agent_maintenance_desired_count == 1
    error_message = "agent_maintenance_desired_count must be zero or one."
  }
}

variable "agentcore_dispatch_publisher_desired_count" {
  description = "Desired ECS task count for the singleton AgentCore dispatch publisher."
  type        = number
  default     = 1

  validation {
    condition     = var.agentcore_dispatch_publisher_desired_count == 0 || var.agentcore_dispatch_publisher_desired_count == 1
    error_message = "agentcore_dispatch_publisher_desired_count must be zero or one."
  }
}

variable "chat_api_cpu" {
  description = "Fargate CPU units for chat-api."
  type        = number
  default     = 512
}

variable "chat_api_memory" {
  description = "Fargate memory MiB for chat-api."
  type        = number
  default     = 1024
}

variable "agent_maintenance_cpu" {
  description = "Fargate CPU units for agent-maintenance."
  type        = number
  default     = 256
}

variable "agent_maintenance_memory" {
  description = "Fargate memory MiB for agent-maintenance."
  type        = number
  default     = 512
}

variable "agentcore_dispatch_publisher_cpu" {
  description = "Fargate CPU units for the AgentCore dispatch publisher."
  type        = number
  default     = 256
}

variable "agentcore_dispatch_publisher_memory" {
  description = "Fargate memory MiB for the AgentCore dispatch publisher."
  type        = number
  default     = 512
}

variable "agentcore_dispatch_publisher_interval_ms" {
  description = "Delay between AgentCore Dispatch publication ticks."
  type        = number
  default     = 2000

  validation {
    condition     = var.agentcore_dispatch_publisher_interval_ms > 0 && var.agentcore_dispatch_publisher_interval_ms <= 2147483647
    error_message = "agentcore_dispatch_publisher_interval_ms must be positive and no greater than 2147483647."
  }
}

variable "agentcore_dispatch_queue_name" {
  description = "Production AgentCore Dispatch queue name."
  type        = string
  default     = null
}

variable "agentcore_dispatch_enabled_parameter_name" {
  description = "Fail-closed production AgentCore Dispatch SSM parameter name."
  type        = string
  default     = null
}

variable "agentcore_dispatch_queue_kms_alias_name" {
  description = "Alias of the customer-managed KMS key encrypting the production AgentCore Dispatch queue."
  type        = string
  default     = null
}

variable "chat_api_port" {
  description = "Container port exposed by chat-api."
  type        = number
  default     = 3000
}

variable "agent_maintenance_port" {
  description = "Container port exposed by the agent-maintenance health server."
  type        = number
  default     = 8080
}

variable "live_redis_port" {
  description = "TLS port for the per-Run Redis Live Stream relay."
  type        = number
  default     = 6379
}

variable "live_redis_node_type" {
  description = "ElastiCache node type for the ephemeral AG-UI pub/sub relay."
  type        = string
  default     = "cache.t4g.micro"
}

variable "live_redis_engine_version" {
  description = "Redis engine version for the per-Run Live Stream relay."
  type        = string
  default     = "7.1"
}

variable "alarm_action_arns" {
  description = "Optional SNS topic ARNs notified by Live Stream relay CloudWatch alarms."
  type        = list(string)
  default     = []
}

variable "assign_public_ip" {
  description = "Inherited existing-network constraint: current mymemo-service ECS subnets are public/default subnets with no NAT/VPC endpoint egress path, so agent ECS tasks need public IPs."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch log retention for agent services."
  type        = number
  default     = 30
}

variable "e2b_template" {
  description = "E2B template used by chat-api while it still owns sandbox creation."
  type        = string
  default     = "sandbox-template-dev"
}

variable "worker_e2b_template" {
  description = "Custom E2B template used by the AgentCore Runtime; installs rg and verifies artifact runtime tools."
  type        = string
  default     = "mymemo-agent-sandbox"
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

variable "log_level" {
  description = "Application log level."
  type        = string
  default     = "info"
}

variable "db_ssl" {
  description = "Set to disable only for local non-TLS databases."
  type        = string
  default     = "require"
}

variable "agent_database_name" {
  description = "Database name for writable agent state."
  type        = string
  default     = "mymemo_agent"
}

variable "agent_database_username" {
  description = "Master username for the agent-owned RDS instance."
  type        = string
  default     = "mymemo_agent"
}

variable "agent_db_instance_class" {
  description = "RDS instance class for the dedicated agent database."
  type        = string
  default     = "db.t4g.micro"
}

variable "agent_db_allocated_storage_gb" {
  description = "Initial allocated storage for the dedicated agent database."
  type        = number
  default     = 20
}

variable "agent_db_max_allocated_storage_gb" {
  description = "Autoscaling storage cap for the dedicated agent database."
  type        = number
  default     = 100
}

variable "agent_db_engine_version" {
  description = "PostgreSQL engine version for the dedicated agent database."
  type        = string
  default     = "17"
}

variable "agent_db_backup_retention_days" {
  description = "Backup retention period for the dedicated agent database."
  type        = number
  default     = 7
}

variable "agent_db_deletion_protection" {
  description = "Protect the dedicated agent database from accidental deletion."
  type        = bool
  default     = true
}

variable "kb_database_url_secret_name" {
  description = "Secrets Manager secret name containing the AgentCore Runtime KB_DATABASE_URL. Defaults to <name_prefix>-<environment>-KB_DATABASE_URL."
  type        = string
  default     = null
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

variable "e2b_api_key_secret_name" {
  description = "Secrets Manager secret name containing E2B_API_KEY. Defaults to <name_prefix>-<environment>-E2B_API_KEY."
  type        = string
  default     = null
}
