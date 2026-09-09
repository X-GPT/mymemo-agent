data "aws_ecr_repository" "agent_runtime" {
  name = "mymemo/agent-runtime"
}

variable "agent_runtime_image_digest" {
  description = "Exact ARM64 apps/agent-runtime image digest."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.agent_runtime_image_digest))
    error_message = "agent_runtime_image_digest must be an exact sha256 image digest."
  }
}

resource "aws_bedrockagentcore_agent_runtime" "agent_runtime" {
  agent_runtime_name = "mymemo_agent_${var.environment}"
  description        = "Simplified chat Runtime; v1 remains independently deployed"
  role_arn           = aws_iam_role.agent_runtime.arn
  environment_variables = {
    AWS_REGION                    = var.aws_region
    OPENROUTER_BASE_URL           = var.openrouter_base_url
    OPENROUTER_DEFAULT_MODEL      = var.openrouter_default_model
    OPENROUTER_API_KEY_SECRET_ARN = local.openrouter_api_key_secret_arn
    KB_DATABASE_URL_SECRET_ARN    = local.kb_database_url_secret_arn
    RDS_CA_BUNDLE_PATH            = "/etc/ssl/certs/rds-global-bundle.pem"
    NODE_EXTRA_CA_CERTS           = "/etc/ssl/certs/rds-global-bundle.pem"
    CODE_INTERPRETER_ID           = aws_bedrockagentcore_code_interpreter.hand.code_interpreter_id
    WORKSPACE_BUCKET              = aws_s3_bucket.workspace.bucket
    TURN_BUDGET_MS                = "600000"
    BASH_DEFAULT_TIMEOUT_MS       = "120000"
    PORT                          = "8080"
  }

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${data.aws_ecr_repository.agent_runtime.repository_url}@${var.agent_runtime_image_digest}"
    }
  }

  network_configuration {
    network_mode = "VPC"
    network_mode_config {
      security_groups = [aws_security_group.runtime.id]
      subnets         = values(aws_subnet.private)[*].id
    }
  }

  lifecycle_configuration {
    idle_runtime_session_timeout = 900
    max_lifetime                 = 3600
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  depends_on = [aws_iam_role_policy.agent_runtime]
}

resource "aws_cloudwatch_log_group" "agent_runtime" {
  name              = "/aws/bedrock-agentcore/runtimes/${aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_id}-DEFAULT"
  retention_in_days = var.log_retention_days
}

output "simplified_agent_runtime_arn" {
  description = "Invoke this Runtime with qualifier DEFAULT and Runtime session id = turnId."
  value       = aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_arn
}

output "agent_runtime_image_digest" {
  value = var.agent_runtime_image_digest
}
