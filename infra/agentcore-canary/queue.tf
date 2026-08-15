resource "aws_kms_key" "canary" {
  description             = "AgentCore canary queue and log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "canary" {
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.canary.key_id
}

resource "aws_sqs_queue" "dead_letter" {
  name                       = "${local.name_prefix}-dlq"
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 300
  kms_master_key_id          = aws_kms_key.canary.arn
  sqs_managed_sse_enabled    = false
}

resource "aws_sqs_queue" "dispatch" {
  name                       = "${local.name_prefix}-dispatch"
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 300
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.canary.arn
  sqs_managed_sse_enabled    = false

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 3
  })
}

resource "aws_ssm_parameter" "enabled" {
  name        = "/mymemo/agentcore-canary/${var.environment}/enabled"
  description = "Fail-closed AgentCore canary admission and dispatch control"
  type        = "String"
  value       = "disabled"
}
