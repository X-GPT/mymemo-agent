locals {
  common_name = "${var.name_prefix}-${var.environment}"

  service_security_group_name = "${local.common_name}-services"
  alb_security_group_name     = "${local.common_name}-alb"

  chat_api_name                     = "${local.common_name}-chat-api"
  agent_maintenance_name            = "${local.common_name}-maintenance"
  agentcore_dispatch_publisher_name = "${local.common_name}-agentcore-dispatch-publisher"
  alb_name                          = "${local.common_name}-alb"

  agentcore_dispatch_queue_name = coalesce(
    var.agentcore_dispatch_queue_name,
    "mymemo-agent-agentcore-${var.environment}-dispatch",
  )
  agentcore_dispatch_enabled_parameter_name = coalesce(
    var.agentcore_dispatch_enabled_parameter_name,
    "/mymemo/agentcore-dispatch/${var.environment}/enabled",
  )
  agentcore_dispatch_queue_kms_alias_name = coalesce(
    var.agentcore_dispatch_queue_kms_alias_name,
    "alias/mymemo-agent-agentcore-${var.environment}",
  )
  agentcore_dispatch_queue_url             = aws_sqs_queue.dispatch.url
  agentcore_dispatch_queue_arn             = aws_sqs_queue.dispatch.arn
  agentcore_dispatch_enabled_parameter_arn = aws_ssm_parameter.dispatch_enabled.arn

  shared_service_outputs = data.terraform_remote_state.mymemo_service.outputs

  shared_ecs_subnet_ids = tolist(local.shared_service_outputs.ecs_subnet_ids)

  shared_vpc_id_output = try(local.shared_service_outputs.vpc_id, null)
  shared_vpc_id        = coalesce(local.shared_vpc_id_output, one(data.aws_subnet.shared_ecs_first[*].vpc_id))

  shared_ecs_cluster_arn_output  = try(local.shared_service_outputs.ecs_cluster_arn, null)
  shared_ecs_cluster_name_output = try(local.shared_service_outputs.ecs_cluster_name, null)

  shared_ecs_cluster_arn            = coalesce(local.shared_ecs_cluster_arn_output, one(data.aws_ecs_cluster.shared[*].arn))
  shared_ecs_cluster_name           = coalesce(local.shared_ecs_cluster_name_output, one(data.aws_ecs_cluster.shared[*].cluster_name), try(regex("[^/]+$", local.shared_ecs_cluster_arn_output), null))
  trusted_caller_security_group_ids = var.mymemo_service_api_security_group_ids

  managed_agent_database_url = "postgresql://${var.agent_database_username}@${aws_db_instance.agent.address}:${aws_db_instance.agent.port}/${var.agent_database_name}"

  agent_database_url_environment = [
    { name = "AGENT_DATABASE_URL", value = local.managed_agent_database_url }
  ]

  agent_db_password_secret_arn      = "${aws_db_instance.agent.master_user_secret[0].secret_arn}:password::"
  agent_db_password_base_secret_arn = aws_db_instance.agent.master_user_secret[0].secret_arn
  live_redis_url_secret_arn         = aws_secretsmanager_secret.live_redis_url.arn

  kb_database_url_secret_name    = coalesce(var.kb_database_url_secret_name, "${local.common_name}-KB_DATABASE_URL")
  statsig_server_secret_name     = coalesce(var.statsig_server_secret_name, "${local.common_name}-STATSIG_SERVER_SECRET")
  openrouter_api_key_secret_name = coalesce(var.openrouter_api_key_secret_name, "${local.common_name}-OPENROUTER_API_KEY")
  e2b_api_key_secret_name        = coalesce(var.e2b_api_key_secret_name, "${local.common_name}-E2B_API_KEY")

  kb_database_url_secret_arn    = data.aws_secretsmanager_secret.kb_database_url.arn
  statsig_server_secret_arn     = data.aws_secretsmanager_secret.statsig_server.arn
  openrouter_api_key_secret_arn = data.aws_secretsmanager_secret.openrouter_api_key.arn
  e2b_api_key_secret_arn        = data.aws_secretsmanager_secret.e2b_api_key.arn

  agent_db_password_secret = [
    {
      name      = "DB_PASSWORD"
      valueFrom = local.agent_db_password_secret_arn
    }
  ]

  live_redis_url_secret = [
    { name = "REDIS_URL", valueFrom = local.live_redis_url_secret_arn }
  ]

  chat_api_environment = concat([
    { name = "PORT", value = tostring(var.chat_api_port) },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "DB_SSL", value = var.db_ssl },
    # /v2 MicroVM orchestration (#669): the launch inventory chat-api passes
    # at RunMicrovm. The image itself is registered by the microvm-image
    # workflow, so its ARN is composed here rather than referenced.
    { name = "MICROVM_IMAGE_ARN", value = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:microvm-image:${local.microvm_name}" },
    { name = "MICROVM_EGRESS_CONNECTOR_ARN", value = aws_lambdacore_network_connector.microvm_egress.arn },
    { name = "MICROVM_EXECUTION_ROLE_ARN", value = aws_iam_role.microvm_execution.arn },
    # chat-api's own origin as a VM reaches it: the runHookPayload's
    # MODEL_BASE_URL is this plus /v2/gateway/<conversation>.
    { name = "GATEWAY_BASE_URL", value = "http://${aws_lb.agent.dns_name}" },
    { name = "OPENROUTER_DEFAULT_MODEL", value = var.openrouter_default_model },
  ], local.agent_database_url_environment)

  chat_api_secrets = concat([
    { name = "STATSIG_SERVER_SECRET", valueFrom = local.statsig_server_secret_arn },
    # The /v2 gateway route injects this key; it never reaches a MicroVM.
    { name = "OPENROUTER_API_KEY", valueFrom = local.openrouter_api_key_secret_arn },
    { name = "GATEWAY_TOKEN_SECRET", valueFrom = aws_secretsmanager_secret.gateway_token.arn },
    # Read only to ride the runHookPayload into a MicroVM's trusted process
    # (the in-VM document tools); chat-api never opens the KB itself.
    { name = "KB_DATABASE_URL", valueFrom = local.kb_database_url_secret_arn },
  ], local.live_redis_url_secret, local.agent_db_password_secret)

  agent_maintenance_environment = concat([
    { name = "PORT", value = tostring(var.agent_maintenance_port) },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "DB_SSL", value = var.db_ssl },
  ], local.agent_database_url_environment)

  agent_maintenance_secrets = concat([
    { name = "E2B_API_KEY", valueFrom = local.e2b_api_key_secret_arn },
  ], local.agent_db_password_secret)

  agentcore_dispatch_publisher_environment = concat([
    { name = "AWS_REGION", value = var.aws_region },
    { name = "AGENTCORE_DISPATCH_QUEUE_URL", value = local.agentcore_dispatch_queue_url },
    { name = "AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME", value = local.agentcore_dispatch_enabled_parameter_name },
    { name = "AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS", value = tostring(var.agentcore_dispatch_publisher_interval_ms) },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "DB_SSL", value = var.db_ssl },
  ], local.agent_database_url_environment)

  agentcore_dispatch_publisher_secrets = local.agent_db_password_secret
}
