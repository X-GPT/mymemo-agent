data "aws_iam_policy_document" "front_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "front" {
  name               = "${local.common_name}-front"
  assume_role_policy = data.aws_iam_policy_document.front_assume.json
}

resource "aws_cloudwatch_log_group" "front" {
  name              = "/aws/lambda/${local.common_name}-front"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "front" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.front.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWriteItems"]
    resources = [aws_dynamodb_table.conversations.arn, "${aws_dynamodb_table.conversations.arn}/index/*"]
  }
  statement {
    actions   = ["bedrock-agentcore:StartCodeInterpreterSession", "bedrock-agentcore:InvokeCodeInterpreter", "bedrock-agentcore:StopCodeInterpreterSession", "bedrock-agentcore:GetCodeInterpreterSession"]
    resources = [aws_bedrockagentcore_code_interpreter.hand.code_interpreter_arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [for prefix in ["_history", "_workspace", "_artifacts"] : "${aws_s3_bucket.workspace.arn}/${prefix}/*"]
  }
  statement {
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.workspace.arn}/_transcripts/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.workspace.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["_history/*", "_workspace/*", "_artifacts/*"]
    }
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.statsig_server_secret_arn]
  }
  statement {
    actions = ["bedrock-agentcore:InvokeAgentRuntime"]
    resources = [
      aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_arn}/runtime-endpoint/DEFAULT",
    ]
  }
}

resource "aws_iam_role_policy" "front" {
  role   = aws_iam_role.front.id
  policy = data.aws_iam_policy_document.front.json
}

resource "aws_lambda_function" "front" {
  function_name    = "${local.common_name}-front"
  role             = aws_iam_role.front.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = var.front_lambda_package
  source_code_hash = filebase64sha256(var.front_lambda_package)
  timeout          = 840
  memory_size      = 1024

  environment {
    variables = {
      CONVERSATION_TABLE        = aws_dynamodb_table.conversations.name
      WORKSPACE_BUCKET          = aws_s3_bucket.workspace.bucket
      CODE_INTERPRETER_ID       = aws_bedrockagentcore_code_interpreter.hand.code_interpreter_id
      WORKSPACE_MAX_BYTES       = "67108864"
      AGENT_RUNTIME_ARN         = aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_arn
      STATSIG_SERVER_SECRET_ARN = local.statsig_server_secret_arn
    }
  }
  depends_on = [aws_iam_role_policy.front, aws_cloudwatch_log_group.front]
}

resource "aws_lambda_function_url" "front" {
  function_name      = aws_lambda_function.front.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_lambda_permission" "front_url" {
  statement_id           = "MyMemoServiceFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.front.function_name
  principal              = var.mymemo_service_task_role_arn
  function_url_auth_type = "AWS_IAM"
}

# New Function URLs require both permissions; the second is URL-only.
resource "aws_lambda_permission" "front_url_invoke" {
  statement_id             = "MyMemoServiceViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.front.function_name
  principal                = var.mymemo_service_task_role_arn
  invoked_via_function_url = true
}

data "aws_iam_policy_document" "front_sweep_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:scheduler:${var.aws_region}:${var.aws_account_id}:schedule-group/default"]
    }
  }
}

resource "aws_iam_role" "front_sweep" {
  name               = "${local.common_name}-front-sweep"
  assume_role_policy = data.aws_iam_policy_document.front_sweep_assume.json
}

resource "aws_iam_role_policy" "front_sweep" {
  role = aws_iam_role.front_sweep.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.front.arn
    }]
  })
}

resource "aws_scheduler_schedule" "front_sweep" {
  name                = "${local.common_name}-front-sweep"
  schedule_expression = "rate(5 minutes)"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.front.arn
    role_arn = aws_iam_role.front_sweep.arn
    input    = jsonencode({ source = "mymemo.cleanup" })
  }
  depends_on = [aws_iam_role_policy.front_sweep]
}

output "front_function_url" {
  value = aws_lambda_function_url.front.function_url
}

output "workspace_bucket" {
  value = aws_s3_bucket.workspace.bucket
}

resource "aws_cloudwatch_log_metric_filter" "front_cleanup_age" {
  name           = "${local.common_name}-front-cleanup-age"
  log_group_name = aws_cloudwatch_log_group.front.name
  pattern        = "{ $.cleanupOldestAgeSeconds = * }"

  metric_transformation {
    name      = "CleanupOldestAgeSeconds"
    namespace = "${local.common_name}/Front"
    value     = "$.cleanupOldestAgeSeconds"
    unit      = "Seconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "front_cleanup_age" {
  alarm_name          = "${local.common_name}-front-cleanup-age"
  alarm_description   = "Oldest Conversation awaiting permanent deletion is over one hour old."
  namespace           = "${local.common_name}/Front"
  metric_name         = "CleanupOldestAgeSeconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}
