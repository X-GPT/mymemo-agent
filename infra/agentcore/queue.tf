resource "aws_kms_key" "dispatch" {
  description             = "Production AgentCore dispatch queue encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "dispatch" {
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.dispatch.key_id
}

resource "aws_sqs_queue" "dead_letter" {
  name                       = "${local.name_prefix}-dlq"
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 300
  kms_master_key_id          = aws_kms_key.dispatch.arn
}

resource "aws_sqs_queue" "dispatch" {
  name                       = "${local.name_prefix}-dispatch"
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 180
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.dispatch.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 5
  })
}

resource "aws_ssm_parameter" "dispatch_enabled" {
  name        = "/mymemo/agentcore-dispatch/${var.environment}/enabled"
  description = "Fail-closed AgentCore dispatch control"
  type        = "String"
  value       = "disabled"

  lifecycle {
    ignore_changes = [value]
  }
}
