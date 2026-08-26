data "aws_ecr_repository" "production_runtime" {
  name = "mymemo/agentcore-runtime"
}

data "aws_ecr_repository" "agent_query_runtime" {
  name = "mymemo/agent-query-runtime"
}

removed {
  from = aws_ecr_repository.production_runtime

  lifecycle {
    destroy = false
  }
}

resource "aws_bedrockagentcore_agent_runtime" "runtime" {
  agent_runtime_name    = "mymemo_agentcore_${var.environment}"
  description           = "Production MyMemo AgentCore execution Runtime"
  role_arn              = aws_iam_role.runtime.arn
  environment_variables = local.runtime_environment

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${data.aws_ecr_repository.production_runtime.repository_url}@${var.runtime_image_digest}"
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

resource "aws_bedrockagentcore_agent_runtime" "query" {
  agent_runtime_name    = "mymemo_agent_query_${var.environment}"
  description           = "Gate-closed MyMemo Agent-query verification Runtime"
  role_arn              = aws_iam_role.query_runtime.arn
  environment_variables = local.query_runtime_environment

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${data.aws_ecr_repository.agent_query_runtime.repository_url}@${var.agent_query_runtime_image_digest}"
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  lifecycle_configuration {
    idle_runtime_session_timeout = 900
    max_lifetime                 = 3600
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  depends_on = [aws_iam_role_policy.query_runtime]
}
