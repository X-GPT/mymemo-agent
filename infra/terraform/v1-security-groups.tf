# Temporary retention for #765: AgentCore can take up to eight hours to release
# deleted Runtime ENIs. Remove this file once the old ENIs are gone, then review
# and apply the resulting two-security-group deletion plan.
resource "aws_security_group" "services" {
  name        = "${local.common_name}-services"
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

resource "aws_security_group" "live_redis_clients" {
  name        = "${local.common_name}-live-redis-clients"
  description = "chat-api and AgentCore Runtime clients of the Redis Live Stream lane"
  vpc_id      = local.shared_vpc_id

  lifecycle {
    ignore_changes = [description]
  }
}
