resource "aws_subnet" "private" {
  for_each = local.private_subnets

  vpc_id                  = local.vpc_id
  availability_zone       = each.value.availability_zone
  cidr_block              = each.value.cidr_block
  map_public_ip_on_launch = false

  tags = {
    Name       = "${local.agentcore_name_prefix}-private-${each.key}"
    CostWindow = "persistent-zero-compute"
  }
}

resource "aws_route_table" "private" {
  for_each = local.private_subnets

  vpc_id = local.vpc_id

  tags = {
    Name       = "${local.agentcore_name_prefix}-private-${each.key}"
    CostWindow = "persistent-zero-compute"
  }
}

resource "aws_route_table_association" "private" {
  for_each = local.private_subnets

  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_eip" "fck_nat_egress" {
  for_each = local.private_subnets

  domain = "vpc"

  tags = {
    Name       = "${local.agentcore_name_prefix}-egress-${each.key}"
    CostWindow = "persistent-production-egress"
  }
}

data "aws_ami" "fck_nat" {
  owners = ["568608671756"]

  filter {
    name   = "image-id"
    values = [var.fck_nat_ami_id]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

module "fck_nat_egress" {
  source  = "RaJiska/fck-nat/aws"
  version = "1.5.0"

  for_each = local.private_subnets

  name                 = "${local.agentcore_name_prefix}-egress-${each.key}"
  vpc_id               = local.vpc_id
  subnet_id            = one(local.shared_public_subnet_ids_by_az[each.key])
  ami_id               = data.aws_ami.fck_nat.id
  instance_type        = "t4g.micro"
  ha_mode              = true
  auto_rollout         = true
  eip_allocation_ids   = [aws_eip.fck_nat_egress[each.key].id]
  attach_ssm_policy    = false
  use_cloudwatch_agent = true
  update_route_tables  = false
  encryption           = true
  ebs_root_volume_size = 8

  tags = {
    Name       = "${local.agentcore_name_prefix}-egress-${each.key}"
    CostWindow = "persistent-production-egress"
  }
}

check "fck_nat_public_subnets" {
  assert {
    condition = alltrue([
      for availability_zone in keys(local.private_subnets) : length(local.shared_public_subnet_ids_by_az[availability_zone]) == 1
    ])
    error_message = "Production AgentCore requires exactly one shared public subnet in each Runtime availability zone."
  }
}

resource "aws_route" "private_egress" {
  for_each = local.private_subnets

  depends_on = [module.fck_nat_egress]

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = module.fck_nat_egress[each.key].eni_id
}

resource "aws_cloudwatch_metric_alarm" "fck_nat_unavailable" {
  for_each = local.private_subnets

  alarm_name          = "${local.agentcore_name_prefix}-egress-${each.key}-unavailable"
  alarm_description   = "The zonal fck-nat Auto Scaling group has no in-service instance."
  namespace           = "AWS/AutoScaling"
  metric_name         = "GroupInServiceInstances"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_action_arns

  dimensions = {
    AutoScalingGroupName = module.fck_nat_egress[each.key].name
  }
}

resource "aws_security_group" "runtime" {
  name        = "${local.agentcore_name_prefix}-runtime"
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
    Name = "${local.agentcore_name_prefix}-runtime"
  }
}
