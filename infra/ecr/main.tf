resource "aws_ecr_repository" "chat_api" {
  name                 = "mymemo-agent-chat-api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "agent_maintenance" {
  name                 = "mymemo-agent-maintenance"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "agentcore_dispatch_publisher" {
  name                 = "mymemo-agentcore-dispatch-publisher"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "agentcore_runtime" {
  name                 = "mymemo/agentcore-runtime"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Environment = "prod"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The Agent-query Runtime was retired (ADR-0033). Its immutable repository
# still holds images, so Terraform forgets it and an operator deletes it.
removed {
  from = aws_ecr_repository.agent_query_runtime

  lifecycle {
    destroy = false
  }
}
