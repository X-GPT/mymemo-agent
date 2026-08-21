locals {
  agentcore_name_prefix = "mymemo-agent-agentcore-${var.environment}"
  vpc_id                = local.shared_vpc_id

  exact_secret_arns = [
    local.agent_db_password_base_secret_arn,
    local.kb_database_url_secret_arn,
    local.openrouter_api_key_secret_arn,
    local.e2b_api_key_secret_arn,
    local.live_redis_url_secret_arn,
  ]

  lambda_security_group_ids = [
    aws_security_group.runtime.id,
    aws_security_group.services.id,
  ]
  runtime_security_group_ids = concat(
    local.lambda_security_group_ids,
    [aws_security_group.live_redis_clients.id],
  )

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

  runtime_environment = {
    AWS_REGION                                = var.aws_region
    AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME = aws_ssm_parameter.dispatch_enabled.name
    AGENT_DATABASE_URL                        = local.managed_agent_database_url
    DB_PASSWORD_SECRET_ARN                    = local.agent_db_password_base_secret_arn
    KB_DATABASE_URL_SECRET_ARN                = local.kb_database_url_secret_arn
    OPENROUTER_API_KEY_SECRET_ARN             = local.openrouter_api_key_secret_arn
    E2B_API_KEY_SECRET_ARN                    = local.e2b_api_key_secret_arn
    REDIS_URL_SECRET_ARN                      = local.live_redis_url_secret_arn
    OPENROUTER_BASE_URL                       = var.openrouter_base_url
    OPENROUTER_DEFAULT_MODEL                  = var.openrouter_default_model
    WORKER_E2B_TEMPLATE                       = var.worker_e2b_template
    ARTIFACT_BUCKET                           = aws_s3_bucket.artifacts.bucket
    RDS_CA_BUNDLE_PATH                        = "/etc/ssl/certs/rds-global-bundle.pem"
    NODE_EXTRA_CA_CERTS                       = "/etc/ssl/certs/rds-global-bundle.pem"
    WORKER_HEARTBEAT_INTERVAL_MS              = "15000"
    PORT                                      = "8080"
    LOG_LEVEL                                 = "info"
  }

  lambda_common_environment = {
    AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME = aws_ssm_parameter.dispatch_enabled.name
    AGENT_DATABASE_URL                        = local.managed_agent_database_url
    DB_PASSWORD_SECRET_ARN                    = local.agent_db_password_base_secret_arn
    AGENTCORE_DISPATCH_QUEUE_URL              = aws_sqs_queue.dispatch.url
    RDS_CA_BUNDLE_PATH                        = "/var/task/rds-global-bundle.pem"
    NODE_EXTRA_CA_CERTS                       = "/var/task/rds-global-bundle.pem"
  }
}
