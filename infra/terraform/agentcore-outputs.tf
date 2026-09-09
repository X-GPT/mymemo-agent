output "private_subnet_ids" {
  description = "Persistent private AgentCore subnets."
  value       = values(aws_subnet.private)[*].id
}

output "egress_configurations" {
  description = "Exact zonal fck-nat routes verified after deployment."
  value = {
    for availability_zone in keys(local.private_subnets) : availability_zone => {
      availability_zone      = availability_zone
      private_subnet_id      = aws_subnet.private[availability_zone].id
      public_subnet_id       = module.fck_nat_egress[availability_zone].subnet_id
      route_table_id         = aws_route_table.private[availability_zone].id
      network_interface_id   = module.fck_nat_egress[availability_zone].eni_id
      eip_allocation_id      = aws_eip.fck_nat_egress[availability_zone].id
      autoscaling_group_name = module.fck_nat_egress[availability_zone].name
      ami_id                 = module.fck_nat_egress[availability_zone].ami_id
    }
  }
}

output "runtime_security_group_id" {
  description = "Persistent outbound-only AgentCore Runtime security group."
  value       = aws_security_group.runtime.id
}

output "agent_runtime_id" {
  value = aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_id
}

output "runtime_security_configuration" {
  value = {
    role_arn                     = aws_iam_role.agent_runtime.arn
    environment_variables        = aws_bedrockagentcore_agent_runtime.agent_runtime.environment_variables
    network_mode                 = "VPC"
    subnet_ids                   = sort(values(aws_subnet.private)[*].id)
    security_group_ids           = [aws_security_group.runtime.id]
    idle_runtime_session_timeout = 900
  }
}

output "runtime_secret_arns" {
  value = [local.kb_database_url_secret_arn, local.openrouter_api_key_secret_arn]
}
