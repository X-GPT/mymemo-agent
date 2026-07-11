resource "aws_cloudwatch_log_group" "chat_api" {
  name              = "/ecs/${local.chat_api_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "agent_worker" {
  name              = "/ecs/${local.agent_worker_name}"
  retention_in_days = var.log_retention_days
}

locals {
  live_preview_log_groups = {
    chat-api     = aws_cloudwatch_log_group.chat_api.name
    agent-worker = aws_cloudwatch_log_group.agent_worker.name
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_preview_signals" {
  for_each = local.live_preview_log_groups

  name           = "${local.common_name}-${each.key}-live-preview-signals"
  log_group_name = each.value
  pattern        = "{ $.message = \"Live preview signal\" && $.service = \"${each.key}\" && $.signal = * }"

  metric_transformation {
    name      = "Signals"
    namespace = "${local.common_name}/LivePreview"
    value     = "$.count"
    unit      = "Count"

    dimensions = {
      Service = "$.service"
      Signal  = "$.signal"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_preview_outcomes" {
  for_each = local.live_preview_log_groups

  name           = "${local.common_name}-${each.key}-live-preview-outcomes"
  log_group_name = each.value
  pattern        = "{ $.message = \"Live preview signal\" && $.service = \"${each.key}\" && $.outcome = * }"

  metric_transformation {
    name      = "MessageOutcomes"
    namespace = "${local.common_name}/LivePreview"
    value     = "$.count"
    unit      = "Count"

    dimensions = {
      Service = "$.service"
      Outcome = "$.outcome"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "live_preview_degraded" {
  for_each = local.live_preview_log_groups

  alarm_name          = "${local.common_name}-${each.key}-live-preview-degraded"
  alarm_description   = "${each.key} repeatedly entered Live-only degradation; durable Postgres delivery and service health remain authoritative."
  namespace           = "${local.common_name}/LivePreview"
  metric_name         = "Signals"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    Service = each.key
    Signal  = "degraded"
  }
}

resource "aws_cloudwatch_metric_alarm" "live_preview_drops" {
  for_each = local.live_preview_log_groups

  alarm_name          = "${local.common_name}-${each.key}-live-preview-drops"
  alarm_description   = "${each.key} has a sustained rate of abandoned Live preview messages; durable commits are not affected."
  namespace           = "${local.common_name}/LivePreview"
  metric_name         = "MessageOutcomes"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    Service = each.key
    Outcome = "dropped"
  }
}

resource "aws_cloudwatch_metric_alarm" "live_preview_overflow" {
  for_each = local.live_preview_log_groups

  alarm_name          = "${local.common_name}-${each.key}-live-preview-overflow"
  alarm_description   = "${each.key} has sustained Live preview queue overflow; investigate Redis latency or slow clients."
  namespace           = "${local.common_name}/LivePreview"
  metric_name         = "Signals"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  dimensions = {
    Service = each.key
    Signal  = "queue_overflow"
  }
}

resource "aws_cloudwatch_metric_alarm" "chat_api_unhealthy" {
  alarm_name          = "${local.chat_api_name}-unhealthy-hosts"
  alarm_description   = "chat-api has unhealthy targets behind the internal agent ALB."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    LoadBalancer = aws_lb.agent.arn_suffix
    TargetGroup  = aws_lb_target_group.chat_api.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "chat_api_cpu_high" {
  alarm_name          = "${local.chat_api_name}-cpu-high"
  alarm_description   = "chat-api ECS service CPU is high."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    ClusterName = local.shared_ecs_cluster_name
    ServiceName = aws_ecs_service.chat_api.name
  }
}

resource "aws_cloudwatch_metric_alarm" "agent_worker_cpu_high" {
  alarm_name          = "${local.agent_worker_name}-cpu-high"
  alarm_description   = "agent-worker ECS service CPU is high."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    ClusterName = local.shared_ecs_cluster_name
    ServiceName = aws_ecs_service.agent_worker.name
  }
}
