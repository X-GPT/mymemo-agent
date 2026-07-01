locals {
  common_name = "${var.name_prefix}-${var.environment}"

  service_security_group_name = "${local.common_name}-services"

  chat_api_name     = "${local.common_name}-chat-api"
  agent_worker_name = "${local.common_name}-worker"

  shared_service_outputs = data.terraform_remote_state.mymemo_service.outputs

  shared_ecs_subnet_ids = tolist(local.shared_service_outputs.ecs_subnet_ids)
  shared_vpc_id         = try(local.shared_service_outputs.vpc_id, data.aws_subnet.shared_ecs_first.vpc_id)

  shared_ecs_cluster_arn       = try(local.shared_service_outputs.ecs_cluster_arn, data.aws_ecs_cluster.shared.arn)
  shared_alb_listener_arn      = try(local.shared_service_outputs.https_listener_arn, local.shared_service_outputs.alb_listener_arn, data.aws_lb_listener.shared_https.arn)
  shared_alb_security_group_id = try(local.shared_service_outputs.alb_security_group_id, one(data.aws_lb.shared.security_groups))

  managed_agent_database_url = "postgresql://${var.agent_database_username}@${aws_db_instance.agent.address}:${aws_db_instance.agent.port}/${var.agent_database_name}"

  agent_database_url_environment = [
    { name = "AGENT_DATABASE_URL", value = local.managed_agent_database_url }
  ]

  agent_db_password_secret_arn      = "${aws_db_instance.agent.master_user_secret[0].secret_arn}:password::"
  agent_db_password_base_secret_arn = aws_db_instance.agent.master_user_secret[0].secret_arn

  kb_database_url_secret_name    = coalesce(var.kb_database_url_secret_name, "${local.common_name}-KB_DATABASE_URL")
  llm_token_secret_name          = coalesce(var.llm_token_secret_name, "${local.common_name}-LLM_TOKEN_SECRET")
  statsig_server_secret_name     = coalesce(var.statsig_server_secret_name, "${local.common_name}-STATSIG_SERVER_SECRET")
  openrouter_api_key_secret_name = coalesce(var.openrouter_api_key_secret_name, "${local.common_name}-OPENROUTER_API_KEY")
  e2b_api_key_secret_name        = coalesce(var.e2b_api_key_secret_name, "${local.common_name}-E2B_API_KEY")

  kb_database_url_secret_arn    = data.aws_secretsmanager_secret.kb_database_url.arn
  llm_token_secret_arn          = data.aws_secretsmanager_secret.llm_token.arn
  statsig_server_secret_arn     = data.aws_secretsmanager_secret.statsig_server.arn
  openrouter_api_key_secret_arn = data.aws_secretsmanager_secret.openrouter_api_key.arn
  e2b_api_key_secret_arn        = data.aws_secretsmanager_secret.e2b_api_key.arn

  all_secret_arns = distinct(compact(concat([
    local.agent_db_password_base_secret_arn,
    local.kb_database_url_secret_arn,
    local.llm_token_secret_arn,
    local.statsig_server_secret_arn,
    local.openrouter_api_key_secret_arn,
    local.e2b_api_key_secret_arn,
  ], var.extra_secret_arns)))

  agent_db_password_secret = [
    {
      name      = "DB_PASSWORD"
      valueFrom = local.agent_db_password_secret_arn
    }
  ]

  chat_api_environment = concat([
    { name = "PORT", value = tostring(var.chat_api_port) },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "GATEWAY_PUBLIC_URL", value = var.gateway_public_url },
    { name = "E2B_TEMPLATE", value = var.e2b_template },
    { name = "DB_SSL", value = var.db_ssl },
  ], local.agent_database_url_environment)

  chat_api_secrets = concat([
    { name = "LLM_TOKEN_SECRET", valueFrom = local.llm_token_secret_arn },
    { name = "STATSIG_SERVER_SECRET", valueFrom = local.statsig_server_secret_arn },
    { name = "E2B_API_KEY", valueFrom = local.e2b_api_key_secret_arn },
  ], local.agent_db_password_secret)

  agent_worker_environment = concat([
    { name = "PORT", value = tostring(var.agent_worker_port) },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "OPENROUTER_BASE_URL", value = var.openrouter_base_url },
    { name = "OPENROUTER_DEFAULT_MODEL", value = var.openrouter_default_model },
    { name = "WORKER_MAX_CONCURRENT_RUNS", value = tostring(var.worker_max_concurrent_runs) },
    { name = "WORKER_HEARTBEAT_INTERVAL_MS", value = tostring(var.worker_heartbeat_interval_ms) },
    { name = "WORKER_SHUTDOWN_TIMEOUT_MS", value = tostring(var.worker_shutdown_timeout_ms) },
    { name = "DB_SSL", value = var.db_ssl },
  ], local.agent_database_url_environment)

  agent_worker_secrets = concat([
    { name = "KB_DATABASE_URL", valueFrom = local.kb_database_url_secret_arn },
    { name = "OPENROUTER_API_KEY", valueFrom = local.openrouter_api_key_secret_arn },
    { name = "E2B_API_KEY", valueFrom = local.e2b_api_key_secret_arn },
  ], local.agent_db_password_secret)
}
