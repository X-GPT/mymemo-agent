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
# agent-worker can reach the KB over KB_DATABASE_URL.
kb_database_security_group_id = "sg-0c7084b87f3e109d7"

# Existing mymemo-service ECS subnets are public/default subnets with no
# private NAT/VPC endpoint egress path. Public IP assignment is therefore an
# inherited network constraint, not the preferred production pattern.
assign_public_ip = true

chat_api_desired_count     = 1
agent_worker_desired_count = 1
# The dedicated publisher remains a one-task service in steady state. Its
# advisory lock, rather than task count, is the singleton authority.
agentcore_dispatch_publisher_desired_count = 1

e2b_template                        = "sandbox-template-prod"
worker_e2b_template                 = "mymemo-agent-sandbox"
openrouter_base_url                 = "https://openrouter.ai/api"
openrouter_default_model            = "anthropic/claude-sonnet-4"
worker_max_concurrent_conversations = 2

# Temporary Live Streams only: one small node, with replication and backups
# disabled in redis.tf.
live_redis_node_type      = "cache.t4g.micro"
live_redis_engine_version = "7.1"

# Established account alarm channel used by the shared staging infrastructure.
alarm_action_arns = ["arn:aws:sns:us-west-2:637423444544:mymemo-staging-alarms"]

agent_database_name               = "mymemo_agent"
agent_database_username           = "mymemo_agent"
agent_db_instance_class           = "db.t4g.micro"
agent_db_allocated_storage_gb     = 20
agent_db_max_allocated_storage_gb = 100
agent_db_engine_version           = "17"
agent_db_backup_retention_days    = 7
agent_db_deletion_protection      = true

# Secret values live in AWS Secrets Manager. Terraform resolves these
# conventional names internally unless an environment overrides *_secret_name:
# - mymemo-agent-prod-KB_DATABASE_URL
# - mymemo-agent-prod-STATSIG_SERVER_SECRET
# - mymemo-agent-prod-OPENROUTER_API_KEY
# - mymemo-agent-prod-E2B_API_KEY
