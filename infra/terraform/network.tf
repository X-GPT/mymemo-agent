resource "aws_security_group" "alb" {
  name        = local.alb_security_group_name
  description = "mymemo-agent public ALB inside the existing MyMemo VPC"
  vpc_id      = local.shared_vpc_id

  ingress {
    description = "HTTP from the public internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from the public internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Forward requests to chat-api tasks"
    from_port   = var.chat_api_port
    to_port     = var.chat_api_port
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.shared.cidr_block]
  }
}

resource "aws_security_group" "services" {
  name        = local.service_security_group_name
  description = "mymemo-agent ECS services inside the existing MyMemo VPC"
  vpc_id      = local.shared_vpc_id

  egress {
    description = "Outbound access for provider APIs, E2B, and database endpoints"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "chat_api_from_alb" {
  type                     = "ingress"
  description              = "Agent ALB to chat-api"
  security_group_id        = aws_security_group.services.id
  source_security_group_id = aws_security_group.alb.id
  from_port                = var.chat_api_port
  to_port                  = var.chat_api_port
  protocol                 = "tcp"
}
