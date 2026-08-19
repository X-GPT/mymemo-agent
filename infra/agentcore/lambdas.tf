resource "aws_lambda_function" "consumer" {
  function_name    = "${local.name_prefix}-consumer"
  role             = aws_iam_role.consumer.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.consumerHandler"
  filename         = var.consumer_lambda_package
  source_code_hash = filebase64sha256(var.consumer_lambda_package)
  timeout          = 120
  memory_size      = 1024

  environment {
    variables = merge(local.lambda_common_environment, {
      AGENTCORE_RUNTIME_ARN = aws_bedrockagentcore_agent_runtime.runtime.agent_runtime_arn
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

resource "aws_lambda_event_source_mapping" "consumer" {
  event_source_arn        = aws_sqs_queue.dispatch.arn
  function_name           = aws_lambda_function.consumer.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  enabled                 = true
}
