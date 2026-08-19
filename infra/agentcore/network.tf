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

resource "aws_eip" "egress" {
  for_each = local.private_subnets

  domain = "vpc"

  tags = {
    Name       = "${local.name_prefix}-egress-${each.key}"
    CostWindow = "persistent-production-egress"
  }
}

resource "aws_nat_gateway" "egress" {
  for_each = local.private_subnets

  allocation_id = aws_eip.egress[each.key].id
  subnet_id     = one(local.shared_public_subnet_ids_by_az[each.key])

  lifecycle {
    precondition {
      condition     = data.terraform_remote_state.mymemo_agent.outputs.assign_public_ip
      error_message = "Production AgentCore NAT Gateways require the shared public ECS subnet contract."
    }

    precondition {
      condition     = length(local.shared_public_subnet_ids_by_az[each.key]) == 1
      error_message = "Production AgentCore requires exactly one shared public subnet in each Runtime availability zone."
    }
  }

  tags = {
    Name       = "${local.name_prefix}-egress-${each.key}"
    CostWindow = "persistent-production-egress"
  }
}

resource "aws_route" "private_egress" {
  for_each = local.private_subnets

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.egress[each.key].id
}

resource "aws_security_group" "runtime" {
  name        = "${local.name_prefix}-runtime"
  description = "Outbound-only security group for the production AgentCore Runtime and consumer"
  vpc_id      = local.vpc_id

  egress {
    description = "Outbound egress from the AgentCore private network"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-runtime"
  }
}
