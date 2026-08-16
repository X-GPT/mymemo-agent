resource "aws_subnet" "private" {
  for_each = local.private_subnets

  vpc_id                  = local.vpc_id
  availability_zone       = each.value.availability_zone
  cidr_block              = each.value.cidr_block
  map_public_ip_on_launch = false

  tags = {
    Name       = "${local.name_prefix}-private-${each.key}"
    CostWindow = "persistent-zero-compute"
  }
}

resource "aws_route_table" "private" {
  for_each = local.private_subnets

  vpc_id = local.vpc_id

  tags = {
    Name       = "${local.name_prefix}-private-${each.key}"
    CostWindow = "persistent-zero-compute"
  }
}

resource "aws_route_table_association" "private" {
  for_each = local.private_subnets

  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_security_group" "canary" {
  name        = "${local.name_prefix}-runtime"
  description = "Outbound-only security group for dormant AgentCore canary resources"
  vpc_id      = local.vpc_id

  egress {
    description = "Campaign-only egress through the bounded NAT Gateway"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-runtime"
  }
}

resource "aws_eip" "campaign" {
  count = var.campaign_network_enabled ? 1 : 0

  domain = "vpc"

  tags = {
    Name       = "${local.name_prefix}-campaign"
    CostWindow = "campaign-two-hour-maximum"
  }
}

resource "aws_nat_gateway" "campaign" {
  count = var.campaign_network_enabled ? 1 : 0

  # The ordinary production stack explicitly records that its inherited ECS
  # subnets are public/default subnets. Fail before opening a campaign window if
  # that shared-network contract changes, because a NAT Gateway requires an
  # Internet Gateway route in its placement subnet.
  allocation_id = aws_eip.campaign[0].id
  subnet_id     = data.terraform_remote_state.mymemo_agent.outputs.shared_infra.ecs_subnet_ids[0]

  lifecycle {
    precondition {
      condition     = data.terraform_remote_state.mymemo_agent.outputs.assign_public_ip
      error_message = "The campaign NAT Gateway requires the shared public ECS subnet contract."
    }
  }

  tags = {
    Name       = "${local.name_prefix}-campaign"
    CostWindow = "campaign-two-hour-maximum"
  }
}

resource "aws_route" "campaign_egress" {
  for_each = var.campaign_network_enabled ? local.private_subnets : {}

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.campaign[0].id
}
