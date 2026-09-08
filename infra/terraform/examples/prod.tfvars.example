environment = "prod"

tags = {
  Application = "mymemo-agent"
  Environment = "prod"
  ManagedBy   = "terraform"
}


# Security group on the existing mymemo-service RDS instance (mymemo-staging-pg)
# hosting the KB database. mymemo-agent attaches an ingress rule to it so
# AgentCore Runtime can reach the KB over KB_DATABASE_URL.
kb_database_security_group_id = "sg-0c7084b87f3e109d7"


# fck-nat 1.4.0, published by AWS account 568608671756 for us-west-2 ARM64.
fck_nat_ami_id = "ami-0d1db1251d2b64626"

openrouter_default_model = "anthropic/claude-sonnet-5"

# Established account alarm channel used by the shared staging infrastructure.
alarm_action_arns = ["arn:aws:sns:us-west-2:637423444544:mymemo-staging-alarms"]

# Secret values live in AWS Secrets Manager. Terraform resolves these
# conventional names internally unless an environment overrides *_secret_name:
# - mymemo-agent-prod-KB_DATABASE_URL
# - mymemo-agent-prod-STATSIG_SERVER_SECRET
# - mymemo-agent-prod-OPENROUTER_API_KEY

# Existing API task role allowed to invoke the Function URL.
mymemo_service_task_role_arn = "arn:aws:iam::637423444544:role/mymemo-staging-ecs-task"
