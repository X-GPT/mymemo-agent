locals {
  agentcore_name_prefix = "mymemo-agent-agentcore-${var.environment}"
  vpc_id                = local.shared_vpc_id
  private_subnets = {
    for index, availability_zone in var.availability_zones : availability_zone => {
      availability_zone = availability_zone
      cidr_block        = var.private_subnet_cidrs[index]
    }
  }

  shared_public_subnet_ids_by_az = {
    for subnet_id, subnet in data.aws_subnet.shared_egress :
    subnet.availability_zone => subnet_id...
  }

}
