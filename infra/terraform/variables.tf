variable "aws_region" {
  description = "AWS region for the existing MyMemo environment."
  type        = string
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

variable "agent_alb_certificate_arn" {
  description = "Optional ACM certificate ARN for the agent-owned ALB HTTPS listener. When null, the ALB serves HTTP only."
  type        = string
  default     = null
}

variable "chat_api_image" {
  description = "Fully qualified chat-api container image URI including tag."
  type        = string

  validation {
    condition     = length(var.chat_api_image) > 0
    error_message = "chat_api_image is required."
  }
}

variable "agent_worker_image" {
  description = "Fully qualified agent-worker container image URI including tag."
  type        = string

  validation {
    condition     = length(var.agent_worker_image) > 0
    error_message = "agent_worker_image is required."
  }
}

variable "chat_api_desired_count" {
  description = "Desired ECS task count for chat-api."
  type        = number
  default     = 1
}

variable "agent_worker_desired_count" {
  description = "Desired ECS task count for agent-worker."
  type        = number
  default     = 1
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

variable "agent_worker_cpu" {
  description = "Fargate CPU units for agent-worker."
  type        = number
  default     = 1024
}

variable "agent_worker_memory" {
  description = "Fargate memory MiB for agent-worker."
  type        = number
  default     = 2048
}

variable "chat_api_port" {
  description = "Container port exposed by chat-api."
  type        = number
  default     = 3000
}

variable "agent_worker_port" {
  description = "Container port exposed by agent-worker health server."
  type        = number
  default     = 8080
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

variable "gateway_public_url" {
  description = "Gateway URL reachable by chat-api and E2B sandboxes."
  type        = string
}

variable "e2b_template" {
  description = "E2B template used by chat-api while it still owns sandbox creation."
  type        = string
  default     = "sandbox-template-dev"
}

variable "openrouter_base_url" {
  description = "OpenRouter base URL used by agent-worker."
  type        = string
  default     = "https://openrouter.ai/api"
}

variable "openrouter_default_model" {
  description = "Default OpenRouter model used by agent-worker."
  type        = string
}

variable "worker_max_concurrent_runs" {
  description = "Maximum concurrent runs per agent-worker task."
  type        = number
  default     = 2
}

variable "worker_heartbeat_interval_ms" {
  description = "Active run heartbeat interval for agent-worker."
  type        = number
  default     = 15000
}

variable "worker_shutdown_timeout_ms" {
  description = "Shutdown drain timeout for agent-worker."
  type        = number
  default     = 30000
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
  default     = "17.9"
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
  description = "Secrets Manager secret name containing KB_DATABASE_URL for agent-worker. Defaults to <name_prefix>-<environment>-KB_DATABASE_URL."
  type        = string
  default     = null
}

variable "llm_token_secret_name" {
  description = "Secrets Manager secret name containing LLM_TOKEN_SECRET. Defaults to <name_prefix>-<environment>-LLM_TOKEN_SECRET."
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

variable "extra_secret_arns" {
  description = "Additional secret ARNs the ECS task execution role may read."
  type        = list(string)
  default     = []
}

variable "extra_task_policy_json" {
  description = "Optional additional IAM policy JSON attached to the task role for existing AWS resources."
  type        = string
  default     = ""
}
