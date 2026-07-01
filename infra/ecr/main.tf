resource "aws_ecr_repository" "chat_api" {
  name                 = "mymemo-agent-chat-api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "agent_worker" {
  name                 = "mymemo-agent-worker"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}
