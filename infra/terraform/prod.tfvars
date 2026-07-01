aws_region  = "us-west-2"
environment = "prod"

tags = {
  Application = "mymemo-agent"
  Environment = "prod"
  ManagedBy   = "terraform"
}

# Existing mymemo-service shared infra is read from Terraform remote state.
enable_alb_routing              = true
chat_api_listener_rule_priority = 420

# Existing mymemo-service ECS subnets are public/default subnets with no
# private NAT/VPC endpoint egress path. Public IP assignment is therefore an
# inherited network constraint, not the preferred production pattern.
assign_public_ip = true

chat_api_desired_count     = 1
agent_worker_desired_count = 1

gateway_public_url         = "REPLACE_ME_AGENT_GATEWAY_PUBLIC_URL"
e2b_template               = "sandbox-template-prod"
openrouter_base_url        = "https://openrouter.ai/api"
openrouter_default_model   = "anthropic/claude-sonnet-4"
worker_max_concurrent_runs = 2

agent_database_name               = "mymemo_agent"
agent_database_username           = "mymemo_agent"
agent_db_instance_class           = "db.t4g.micro"
agent_db_allocated_storage_gb     = 20
agent_db_max_allocated_storage_gb = 100
agent_db_engine_version           = "17.9"
agent_db_backup_retention_days    = 7
agent_db_deletion_protection      = true

# Secret values live in AWS Secrets Manager. Terraform resolves these
# conventional names internally unless an environment overrides *_secret_name:
# - mymemo-agent-prod-KB_DATABASE_URL
# - mymemo-agent-prod-LLM_TOKEN_SECRET
# - mymemo-agent-prod-STATSIG_SERVER_SECRET
# - mymemo-agent-prod-OPENROUTER_API_KEY
# - mymemo-agent-prod-E2B_API_KEY
