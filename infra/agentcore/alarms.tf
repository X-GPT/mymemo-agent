resource "aws_cloudwatch_metric_alarm" "pending_publication_age" {
  alarm_name          = "${local.name_prefix}-pending-publication-age"
  alarm_description   = "AgentCore Dispatch publication has remained pending beyond one minute"
  namespace           = "MyMemo/AgentCoreDispatch"
  metric_name         = "PendingAgeMs"
  dimensions          = {}
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 60000
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "publisher_errors" {
  alarm_name          = "${local.name_prefix}-publisher-errors"
  alarm_description   = "AgentCore Dispatch publisher errors have persisted across three of five minutes"
  namespace           = "MyMemo/AgentCoreDispatch"
  metric_name         = "PublisherErrors"
  dimensions          = {}
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "poison_dispatch" {
  alarm_name          = "${local.name_prefix}-poison-dispatch"
  alarm_description   = "The AgentCore consumer rejected invalid Dispatch work"
  namespace           = "MyMemo/AgentCoreDispatch"
  metric_name         = "PoisonDispatch"
  dimensions          = {}
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "dead_letter_work" {
  alarm_name          = "${local.name_prefix}-dead-letter-work"
  alarm_description   = "AgentCore poison or repeatedly failing Dispatch work reached the DLQ"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dead_letter.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
}

locals {
  dispatch_alarms = [
    aws_cloudwatch_metric_alarm.pending_publication_age,
    aws_cloudwatch_metric_alarm.publisher_errors,
    aws_cloudwatch_metric_alarm.poison_dispatch,
    aws_cloudwatch_metric_alarm.dead_letter_work,
  ]

  alarm_configurations = {
    for alarm in local.dispatch_alarms : alarm.alarm_name => {
      namespace           = alarm.namespace
      metric_name         = alarm.metric_name
      dimensions          = alarm.dimensions
      statistic           = alarm.statistic
      period              = alarm.period
      evaluation_periods  = alarm.evaluation_periods
      datapoints_to_alarm = alarm.datapoints_to_alarm
      comparison_operator = alarm.comparison_operator
      threshold           = alarm.threshold
      treat_missing_data  = alarm.treat_missing_data
      actions_enabled     = alarm.actions_enabled
      alarm_actions       = sort(tolist(coalesce(alarm.alarm_actions, toset([]))))
    }
  }
}
