resource "aws_lambda_function" "publisher" {
  function_name    = "${local.name_prefix}-publisher"
  role             = aws_iam_role.publisher.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.publisherHandler"
  filename         = var.dispatch_lambda_package
  source_code_hash = filebase64sha256(var.dispatch_lambda_package)
  timeout          = 60
  memory_size      = 512

  environment {
    variables = local.lambda_common_environment
  }

  vpc_config {
    security_group_ids = local.lambda_security_group_ids
    subnet_ids         = values(aws_subnet.private)[*].id
  }

  depends_on = [
    aws_iam_role_policy.publisher,
    aws_iam_role_policy.publisher_base,
  ]
}

resource "aws_lambda_function" "consumer" {
  function_name                  = "${local.name_prefix}-consumer"
  role                           = aws_iam_role.consumer.arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.consumerHandler"
  filename                       = var.dispatch_lambda_package
  source_code_hash               = filebase64sha256(var.dispatch_lambda_package)
  timeout                        = 120
  reserved_concurrent_executions = 1
  memory_size                    = 1024

  environment {
    variables = merge(local.lambda_common_environment, {
      CANARY_AGENT_RUNTIME_ARN = aws_bedrockagentcore_agent_runtime.canary.agent_runtime_arn
    })
  }

  vpc_config {
    security_group_ids = local.lambda_security_group_ids
    subnet_ids         = values(aws_subnet.private)[*].id
  }

  depends_on = [
    aws_iam_role_policy.consumer,
    aws_iam_role_policy.consumer_base,
  ]
}

resource "aws_lambda_function" "control" {
  function_name    = "${local.name_prefix}-control"
  role             = aws_iam_role.control.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = var.control_lambda_package
  source_code_hash = filebase64sha256(var.control_lambda_package)
  timeout          = 120
  memory_size      = 1024

  environment {
    variables = merge(local.lambda_common_environment, {
      CANARY_KB_DATABASE_URL_SECRET_ARN = var.kb_database_url_secret_arn
      CANARY_APPROVED_SYNTHETIC_USER_ID = var.canary_approved_synthetic_user_id
      CANARY_CONTROL_CONFIG_JSON        = var.canary_control_config_json
    })
  }

  vpc_config {
    security_group_ids = local.lambda_security_group_ids
    subnet_ids         = values(aws_subnet.private)[*].id
  }

  depends_on = [
    aws_iam_role_policy.control,
    aws_iam_role_policy.control_base,
  ]
}

resource "aws_lambda_function" "preflight" {
  function_name    = "${local.name_prefix}-preflight"
  role             = aws_iam_role.preflight.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.preflightHandler"
  filename         = var.control_lambda_package
  source_code_hash = filebase64sha256(var.control_lambda_package)
  timeout          = 60
  memory_size      = 512

  environment {
    variables = merge(local.lambda_common_environment, {
      CANARY_KB_DATABASE_URL_SECRET_ARN = var.kb_database_url_secret_arn
    })
  }

  vpc_config {
    security_group_ids = local.lambda_security_group_ids
    subnet_ids         = values(aws_subnet.private)[*].id
  }

  depends_on = [aws_iam_role_policy.preflight]
}

resource "aws_lambda_event_source_mapping" "consumer" {
  event_source_arn        = aws_sqs_queue.dispatch.arn
  function_name           = aws_lambda_function.consumer.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  enabled                 = var.dispatch_enabled

  lifecycle {
    precondition {
      condition     = !var.dispatch_enabled || var.campaign_network_enabled
      error_message = "Dispatch cannot be enabled without the campaign-scoped network."
    }
  }
}

resource "aws_cloudwatch_event_rule" "repair" {
  name                = "${local.name_prefix}-repair"
  description         = "Minute repair invocation of the shared canary publisher handler"
  schedule_expression = "rate(1 minute)"
  state               = var.dispatch_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "repair" {
  rule      = aws_cloudwatch_event_rule.repair.name
  target_id = "shared-publisher"
  arn       = aws_lambda_function.publisher.arn
}

resource "aws_lambda_permission" "repair" {
  statement_id  = "AllowEventBridgeRepair"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.publisher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.repair.arn
}
