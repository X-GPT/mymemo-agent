locals {
  name_prefix = "mymemo-agent-agentcore-${var.environment}"
  vpc_id      = data.terraform_remote_state.mymemo_agent.outputs.shared_infra.vpc_id

  exact_secret_arn_pattern = "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:[A-Za-z0-9/_+=.@-]+$"
  exact_secret_arns = [
    var.agent_database_url_secret_arn,
    var.kb_database_url_secret_arn,
    var.openrouter_api_key_secret_arn,
    var.e2b_api_key_secret_arn,
    var.redis_url_secret_arn,
  ]

  lambda_security_group_ids = [
    aws_security_group.runtime.id,
    data.terraform_remote_state.mymemo_agent.outputs.service_security_group_id,
  ]
  runtime_security_group_ids = concat(
    local.lambda_security_group_ids,
    [data.aws_security_group.live_redis_clients.id],
  )

  private_subnets = {
    for index, availability_zone in var.availability_zones : availability_zone => {
      availability_zone = availability_zone
      cidr_block        = var.private_subnet_cidrs[index]
    }
  }

  runtime_environment = {
    AWS_REGION                                = var.aws_region
    AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME = aws_ssm_parameter.dispatch_enabled.name
    AGENT_DATABASE_URL_SECRET_ARN             = var.agent_database_url_secret_arn
    KB_DATABASE_URL_SECRET_ARN                = var.kb_database_url_secret_arn
    OPENROUTER_API_KEY_SECRET_ARN             = var.openrouter_api_key_secret_arn
    E2B_API_KEY_SECRET_ARN                    = var.e2b_api_key_secret_arn
    REDIS_URL_SECRET_ARN                      = var.redis_url_secret_arn
    OPENROUTER_BASE_URL                       = var.openrouter_base_url
    OPENROUTER_DEFAULT_MODEL                  = var.openrouter_default_model
    WORKER_E2B_TEMPLATE                       = var.worker_e2b_template
    ARTIFACT_BUCKET                           = var.artifact_bucket_name
    RDS_CA_BUNDLE_PATH                        = "/etc/ssl/certs/rds-global-bundle.pem"
    NODE_EXTRA_CA_CERTS                       = "/etc/ssl/certs/rds-global-bundle.pem"
    WORKER_HEARTBEAT_INTERVAL_MS              = "15000"
    PORT                                      = "8080"
    LOG_LEVEL                                 = "info"
  }

  lambda_common_environment = {
    AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME = aws_ssm_parameter.dispatch_enabled.name
    AGENT_DATABASE_URL_SECRET_ARN             = var.agent_database_url_secret_arn
    AGENTCORE_DISPATCH_QUEUE_URL              = aws_sqs_queue.dispatch.url
    RDS_CA_BUNDLE_PATH                        = "/var/task/rds-global-bundle.pem"
    NODE_EXTRA_CA_CERTS                       = "/var/task/rds-global-bundle.pem"
  }
}
