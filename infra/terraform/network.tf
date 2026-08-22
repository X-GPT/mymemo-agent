resource "aws_security_group" "alb" {
  name        = local.alb_security_group_name
  description = "mymemo-agent internal ALB inside the existing MyMemo VPC"
  vpc_id      = local.shared_vpc_id

  ingress {
    description     = "HTTP from mymemo-service API"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = local.trusted_caller_security_group_ids
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

resource "aws_security_group" "agentcore_dispatch_publisher" {
  name        = "${local.common_name}-agentcore-dispatch-publisher"
  description = "Outbound-only AgentCore dispatch publisher"
  vpc_id      = local.shared_vpc_id

  egress {
    description = "Postgres, SSM, SQS, KMS, ECR, and CloudWatch Logs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "agent_maintenance" {
  name        = local.agent_maintenance_name
  description = "Outbound-only global Run maintenance service"
  vpc_id      = local.shared_vpc_id

  egress {
    description     = "Dedicated agent Postgres"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.agent_db.id]
  }

  egress {
    description = "E2B cleanup and AWS APIs over HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "VPC DNS over UDP"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [data.aws_vpc.shared.cidr_block]
  }

  egress {
    description = "VPC DNS over TCP"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.shared.cidr_block]
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

resource "aws_security_group_rule" "chat_api_service_connect_from_trusted_callers" {
  for_each = toset(local.trusted_caller_security_group_ids)

  type                     = "ingress"
  description              = "Trusted mymemo-service API to chat-api Service Connect proxy"
  security_group_id        = aws_security_group.services.id
  source_security_group_id = each.value
  from_port                = local.chat_api_service_connect_ingress_port
  to_port                  = local.chat_api_service_connect_ingress_port
  protocol                 = "tcp"
}
