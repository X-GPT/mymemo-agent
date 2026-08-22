environment = "prod"

tags = {
  Application = "mymemo-agent"
  Environment = "prod"
  ManagedBy   = "terraform"
}

# Existing mymemo-service VPC/subnets/ECS cluster are read from Terraform remote
# state. The internal ALB is owned by mymemo-agent and accepts traffic only from
# the mymemo-service API ECS service security group.
mymemo_service_api_security_group_ids = ["sg-05d48e36ef8966c9e"]

# Security group on the existing mymemo-service RDS instance (mymemo-staging-pg)
# hosting the KB database. mymemo-agent attaches an ingress rule to it so
# AgentCore Runtime can reach the KB over KB_DATABASE_URL.
kb_database_security_group_id = "sg-0c7084b87f3e109d7"

# Existing mymemo-service ECS subnets are public/default subnets with no
# private NAT/VPC endpoint egress path. Public IP assignment is therefore an
# inherited network constraint, not the preferred production pattern.
assign_public_ip = true

# fck-nat 1.4.0, published by AWS account 568608671756 for us-west-2 ARM64.
fck_nat_ami_id = "ami-0d1db1251d2b64626"

# Production must keep exactly one always-on global maintenance owner.
agent_maintenance_desired_count = 1

openrouter_default_model = "anthropic/claude-sonnet-4"

# Established account alarm channel used by the shared staging infrastructure.
alarm_action_arns = ["arn:aws:sns:us-west-2:637423444544:mymemo-staging-alarms"]

# Secret values live in AWS Secrets Manager. Terraform resolves these
# conventional names internally unless an environment overrides *_secret_name:
# - mymemo-agent-prod-KB_DATABASE_URL
# - mymemo-agent-prod-STATSIG_SERVER_SECRET
# - mymemo-agent-prod-OPENROUTER_API_KEY
# - mymemo-agent-prod-E2B_API_KEY
