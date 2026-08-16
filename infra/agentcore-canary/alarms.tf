resource "aws_cloudwatch_metric_alarm" "dispatch_age" {
  alarm_name          = "${local.name_prefix}-dispatch-age"
  alarm_description   = "Canary dispatch has remained pending beyond the five-minute control deadline"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.dispatch.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 300
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.incident_alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "dead_letter_work" {
  alarm_name          = "${local.name_prefix}-dead-letter-work"
  alarm_description   = "Canary poison or repeatedly failing dispatch reached the DLQ"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dead_letter.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.incident_alarm_action_arns
}

locals {
  alarmed_lambda_functions = {
    control   = aws_lambda_function.control.function_name
    preflight = aws_lambda_function.preflight.function_name
    publisher = aws_lambda_function.publisher.function_name
    consumer  = aws_lambda_function.consumer.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.alarmed_lambda_functions

  alarm_name          = "${local.name_prefix}-${each.key}-errors"
  alarm_description   = "Canary ${each.key} Lambda errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.incident_alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = local.alarmed_lambda_functions

  alarm_name          = "${local.name_prefix}-${each.key}-throttles"
  alarm_description   = "Canary ${each.key} Lambda throttling"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.incident_alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "consumer_duration" {
  alarm_name          = "${local.name_prefix}-consumer-duration"
  alarm_description   = "Canary consumer approached its hard 120-second timeout"
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = aws_lambda_function.consumer.function_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 110000
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.incident_alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "dormant_runtime_sessions" {
  alarm_name          = "${local.name_prefix}-dormant-runtime-sessions"
  alarm_description   = "An account-level AgentCore Runtime session exists in this region while canary dispatch is dormant"
  namespace           = "AWS/Bedrock-AgentCore"
  metric_name         = "ActiveSessionCount"
  dimensions          = { Service = "AgentCore.Runtime" }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  actions_enabled     = !var.dispatch_enabled
  alarm_actions       = var.incident_alarm_action_arns
}

locals {
  incident_metric_alarms = toset([
    "PoisonDispatch",
    "CrossLaneExecution",
    "CleanupResidue",
    "CampaignDeadlineBreach",
    "NatExpiryBreach",
    "DisabledDelivery",
  ])
  validation_metric_alarms = toset([
    "ExpectedReclamation",
    "ExpectedWorkspaceTaint",
  ])
}

resource "aws_cloudwatch_metric_alarm" "incident" {
  for_each = local.incident_metric_alarms

  alarm_name          = "${local.name_prefix}-${lower(each.value)}"
  alarm_description   = "AgentCore canary safety signal ${each.value}"
  namespace           = "MyMemo/AgentCoreCanary"
  metric_name         = each.value
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.incident_alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "validation" {
  for_each = local.validation_metric_alarms

  alarm_name          = "${local.name_prefix}-${lower(each.value)}"
  alarm_description   = "AgentCore canary expected validation signal ${each.value}"
  namespace           = "MyMemo/AgentCoreCanary"
  metric_name         = each.value
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.validation_alarm_action_arns
}

locals {
  canary_alarms = concat(
    [
      aws_cloudwatch_metric_alarm.dispatch_age,
      aws_cloudwatch_metric_alarm.dead_letter_work,
      aws_cloudwatch_metric_alarm.consumer_duration,
      aws_cloudwatch_metric_alarm.dormant_runtime_sessions,
    ],
    values(aws_cloudwatch_metric_alarm.lambda_errors),
    values(aws_cloudwatch_metric_alarm.lambda_throttles),
    values(aws_cloudwatch_metric_alarm.incident),
    values(aws_cloudwatch_metric_alarm.validation),
  )

  alarm_configurations = {
    for alarm in local.canary_alarms : alarm.alarm_name => {
      namespace           = alarm.namespace
      metric_name         = alarm.metric_name
      dimensions          = alarm.dimensions
      statistic           = alarm.statistic
      period              = alarm.period
      evaluation_periods  = alarm.evaluation_periods
      comparison_operator = alarm.comparison_operator
      threshold           = alarm.threshold
      treat_missing_data  = alarm.treat_missing_data
      actions_enabled     = alarm.actions_enabled
      alarm_actions       = sort(tolist(alarm.alarm_actions))
    }
  }
}
