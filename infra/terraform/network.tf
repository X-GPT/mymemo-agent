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
  count = var.enable_alb_routing ? 1 : 0

  type                     = "ingress"
  description              = "Existing MyMemo ALB to chat-api"
  security_group_id        = aws_security_group.services.id
  source_security_group_id = local.shared_alb_security_group_id
  from_port                = var.chat_api_port
  to_port                  = var.chat_api_port
  protocol                 = "tcp"
}
