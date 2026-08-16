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
