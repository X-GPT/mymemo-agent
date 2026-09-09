locals {
  common_name                    = "${var.name_prefix}-${var.environment}"
  shared_service_outputs         = data.terraform_remote_state.mymemo_service.outputs
  shared_ecs_subnet_ids          = tolist(local.shared_service_outputs.ecs_subnet_ids)
  shared_vpc_id_output           = try(local.shared_service_outputs.vpc_id, null)
  shared_vpc_id                  = coalesce(local.shared_vpc_id_output, one(data.aws_subnet.shared_ecs_first[*].vpc_id))
  kb_database_url_secret_name    = coalesce(var.kb_database_url_secret_name, "${local.common_name}-KB_DATABASE_URL")
  statsig_server_secret_name     = coalesce(var.statsig_server_secret_name, "${local.common_name}-STATSIG_SERVER_SECRET")
  openrouter_api_key_secret_name = coalesce(var.openrouter_api_key_secret_name, "${local.common_name}-OPENROUTER_API_KEY")
  kb_database_url_secret_arn     = data.aws_secretsmanager_secret.kb_database_url.arn
  statsig_server_secret_arn      = data.aws_secretsmanager_secret.statsig_server.arn
  openrouter_api_key_secret_arn  = data.aws_secretsmanager_secret.openrouter_api_key.arn
}
