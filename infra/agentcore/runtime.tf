resource "aws_ecr_repository" "production_runtime" {
  name                 = "mymemo/agentcore-runtime"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# The existing repository remains Terraform-managed during the one-time image
# copy. It is removed only after the production Runtime is healthy on the copied
# or newly built digest.
resource "aws_ecr_repository" "legacy_runtime" {
  count = var.retain_legacy_runtime_repository ? 1 : 0

  name                 = "mymemo/agentcore-canary-runtime"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_bedrockagentcore_agent_runtime" "runtime" {
  agent_runtime_name    = "mymemo_agentcore_${var.environment}"
  description           = "Production MyMemo AgentCore execution Runtime"
  role_arn              = aws_iam_role.runtime.arn
  environment_variables = local.runtime_environment

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${aws_ecr_repository.production_runtime.repository_url}@${var.runtime_image_digest}"
    }
  }

  network_configuration {
    network_mode = "VPC"

    network_mode_config {
      security_groups = local.runtime_security_group_ids
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

  lifecycle {
    precondition {
      condition = alltrue([
        for arn in local.exact_secret_arns : can(regex(local.exact_secret_arn_pattern, arn))
      ])
      error_message = "Every runtime secret input must be an exact same-account, same-region Secrets Manager ARN without a wildcard or JSON-key suffix."
    }
  }

  depends_on = [aws_iam_role_policy.runtime]
}
