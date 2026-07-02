data "aws_secretsmanager_secret" "kb_database_url" {
  name = local.kb_database_url_secret_name
}

data "aws_secretsmanager_secret" "llm_token" {
  name = local.llm_token_secret_name
}

data "aws_secretsmanager_secret" "statsig_server" {
  name = local.statsig_server_secret_name
}

data "aws_secretsmanager_secret" "openrouter_api_key" {
  name = local.openrouter_api_key_secret_name
}

data "aws_secretsmanager_secret" "e2b_api_key" {
  name = local.e2b_api_key_secret_name
}
