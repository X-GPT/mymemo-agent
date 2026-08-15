resource "aws_ecr_repository" "runtime" {
  name                 = "mymemo/agentcore-canary-runtime"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "runtime" {
  repository = aws_ecr_repository.runtime.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain digest-addressable release images; expire only abandoned untagged uploads"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_bedrockagentcore_agent_runtime" "canary" {
  agent_runtime_name    = "mymemo_agentcore_canary_${var.environment}"
  description           = "Dormant synthetic-only MyMemo AgentCore canary"
  role_arn              = aws_iam_role.runtime.arn
  environment_variables = local.runtime_environment

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${aws_ecr_repository.runtime.repository_url}@${var.runtime_image_digest}"
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

  depends_on = [aws_iam_role_policy.runtime]
}
