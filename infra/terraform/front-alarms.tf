# IDs remain in logs, never metric dimensions (one time series per error code).
locals {
  front_metrics = merge({
    TurnOutcomes         = { pattern = "{ $.event = \"turn_finished\" || $.event = \"turn_abandoned\" }", value = "1", unit = "Count" }
    SandboxStartSeconds  = { pattern = "{ $.event = \"sandbox_started\" }", value = "$.startSeconds", unit = "Seconds" }
    SandboxStartFailures = { pattern = "{ $.event = \"turn_operation_failed\" && $.stage = \"sandbox_start\" }", value = "1", unit = "Count" }
    PersistenceFailures  = { pattern = "{ $.event = \"turn_persistence_failed\" }", value = "1", unit = "Count" }
    TarballBytes         = { pattern = "{ $.tarballBytes = * }", value = "$.tarballBytes", unit = "Bytes" }
    CopyInSeconds        = { pattern = "{ $.event = \"workspace_restore\" }", value = "$.copySeconds", unit = "Seconds" }
    CopyOutSeconds       = { pattern = "{ $.event = \"workspace_save\" }", value = "$.copySeconds", unit = "Seconds" }
    }, {
    for code in ["budget_exceeded", "workspace_too_large", "internal_error", "quota_exceeded", "abandoned"] : "TurnErrors_${code}" => {
      pattern = "{ ($.event = \"turn_finished\" || $.event = \"turn_abandoned\") && $.errorCode = \"${code}\" }"
      value   = "1"
      unit    = "Count"
    }
  })
}

resource "aws_cloudwatch_log_metric_filter" "front" {
  for_each       = local.front_metrics
  name           = "${local.common_name}-front-${each.key}"
  log_group_name = aws_cloudwatch_log_group.front.name
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.key
    namespace     = "${local.common_name}/Front"
    value         = each.value.value
    unit          = each.value.unit
    default_value = each.value.unit == "Count" ? 0 : null
  }
}

resource "aws_cloudwatch_metric_alarm" "front_count" {
  for_each            = toset(["SandboxStartFailures", "PersistenceFailures", "TurnErrors_budget_exceeded", "TurnErrors_workspace_too_large"])
  alarm_name          = "${local.common_name}-front-${each.key}"
  namespace           = "${local.common_name}/Front"
  metric_name         = aws_cloudwatch_log_metric_filter.front[each.key].metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "front_error_rate" {
  for_each            = toset(["budget_exceeded", "workspace_too_large", "internal_error", "quota_exceeded", "abandoned"])
  alarm_name          = "${local.common_name}-front-error-rate-${each.key}"
  alarm_description   = "Over 5% of observed Turn outcomes have this error in five minutes."
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
  metric_query {
    id          = "rate"
    expression  = "IF(outcomes > 0, 100 * FILL(errors, 0) / outcomes, 0)"
    return_data = true
  }
  metric_query {
    id = "errors"
    metric {
      namespace   = "${local.common_name}/Front"
      metric_name = aws_cloudwatch_log_metric_filter.front["TurnErrors_${each.key}"].metric_transformation[0].name
      period      = 300
      stat        = "Sum"
    }
  }
  metric_query {
    id = "outcomes"
    metric {
      namespace   = "${local.common_name}/Front"
      metric_name = aws_cloudwatch_log_metric_filter.front["TurnOutcomes"].metric_transformation[0].name
      period      = 300
      stat        = "Sum"
    }
  }
}

# Errors also covers hard Lambda timeouts and failed scheduled sweeps.
resource "aws_cloudwatch_metric_alarm" "front_platform" {
  for_each            = toset(["Url5xxCount", "Errors"])
  alarm_name          = "${local.common_name}-front-${each.key}"
  namespace           = "AWS/Lambda"
  metric_name         = each.key
  dimensions          = { FunctionName = aws_lambda_function.front.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "transcript_upload" {
  alarm_name          = "${local.common_name}-transcript-upload-failures"
  namespace           = "MyMemo/AgentRuntime"
  metric_name         = "TranscriptUploadFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "runtime_health" {
  alarm_name  = "${local.common_name}-runtime-system-errors"
  namespace   = "AWS/Bedrock-AgentCore"
  metric_name = "SystemErrors"
  dimensions = {
    Resource  = aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_arn
    Operation = "InvokeAgentRuntime"
    Name      = "${aws_bedrockagentcore_agent_runtime.agent_runtime.agent_runtime_name}::DEFAULT"
  }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}
