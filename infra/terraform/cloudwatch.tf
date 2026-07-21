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

resource "aws_cloudwatch_metric_alarm" "live_preview_widespread_degraded" {
  alarm_name          = "${local.common_name}-live-preview-widespread-degraded"
  alarm_description   = "Multiple agent services repeatedly entered Live-only degradation; durable Postgres delivery and service health remain authoritative."
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns

  metric_query {
    id          = "widespread"
    expression  = "IF(FILL(chat, 0) > 0, 1, 0) + IF(FILL(worker, 0) > 0, 1, 0)"
    label       = "Services degraded"
    return_data = true
  }

  metric_query {
    id          = "chat"
    return_data = false

    metric {
      namespace   = "${local.common_name}/LivePreview"
      metric_name = "Signals"
      period      = 300
      stat        = "Sum"

      dimensions = {
        Service = "chat-api"
        Signal  = "degraded"
      }
    }
  }

  metric_query {
    id          = "worker"
    return_data = false

    metric {
      namespace   = "${local.common_name}/LivePreview"
      metric_name = "Signals"
      period      = 300
      stat        = "Sum"

      dimensions = {
        Service = "agent-worker"
        Signal  = "degraded"
      }
    }
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

resource "aws_cloudwatch_log_metric_filter" "live_stream_operations" {
  for_each = local.live_preview_log_groups

  name           = "${local.common_name}-${each.key}-live-stream-operations"
  log_group_name = each.value
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"${each.key}\" && $.operation = * && $.result = * }"

  metric_transformation {
    name      = "Operations"
    namespace = "${local.common_name}/LiveStream"
    value     = "$.count"
    unit      = "Count"

    dimensions = {
      Service   = "$.service"
      Operation = "$.operation"
      Result    = "$.result"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_stream_latency" {
  for_each = local.live_preview_log_groups

  name           = "${local.common_name}-${each.key}-live-stream-latency"
  log_group_name = each.value
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"${each.key}\" && $.operation = * && $.durationMs = * }"

  metric_transformation {
    name      = "OperationLatencyMs"
    namespace = "${local.common_name}/LiveStream"
    value     = "$.durationMs"
    unit      = "Milliseconds"

    dimensions = {
      Service   = "$.service"
      Operation = "$.operation"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_stream_redis_unavailable" {
  for_each = local.live_preview_log_groups

  name           = "${local.common_name}-${each.key}-live-stream-redis-unavailable"
  log_group_name = each.value
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"${each.key}\" && $.reason = \"redis_unavailable\" }"

  metric_transformation {
    name      = "RedisUnavailable"
    namespace = "${local.common_name}/LiveStream"
    value     = "$.count"
    unit      = "Count"

    dimensions = {
      Service = "$.service"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_stream_recovery" {
  name           = "${local.common_name}-chat-api-live-stream-recovery"
  log_group_name = aws_cloudwatch_log_group.chat_api.name
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"chat-api\" && $.operation = \"recovery_response\" && $.result = * }"

  metric_transformation {
    name      = "RecoveryResponses"
    namespace = "${local.common_name}/LiveStream"
    value     = "$.count"
    unit      = "Count"

    dimensions = {
      Service = "$.service"
      Result  = "$.result"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_stream_capacity" {
  for_each = toset([
    "event_too_large",
    "stream_bytes_exceeded",
    "stream_events_exceeded",
  ])

  name           = "${local.common_name}-agent-worker-live-stream-capacity-${replace(each.key, "_", "-")}"
  log_group_name = aws_cloudwatch_log_group.agent_worker.name
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"agent-worker\" && $.reason = \"${each.key}\" }"

  metric_transformation {
    name      = "CapacityFailures"
    namespace = "${local.common_name}/LiveStream"
    value     = "$.count"
    unit      = "Count"

    dimensions = {
      Service = "$.service"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_stream_degraded_duration" {
  name           = "${local.common_name}-agent-worker-live-stream-degraded-duration"
  log_group_name = aws_cloudwatch_log_group.agent_worker.name
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"agent-worker\" && $.operation = \"degradation\" && $.result = \"ended\" && $.durationMs = * }"

  metric_transformation {
    name      = "DegradedDurationMs"
    namespace = "${local.common_name}/LiveStream"
    value     = "$.durationMs"
    unit      = "Milliseconds"

    dimensions = {
      Service = "$.service"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "live_stream_redis_unavailable" {
  for_each = local.live_preview_log_groups

  alarm_name          = "${local.common_name}-${each.key}-live-stream-redis-unavailable"
  alarm_description   = "${each.key} has sustained Redis failures. agent-worker owns Live Stream production; chat-api owns reconnect and recovery responses. See docs/runbooks/live-stream.md."
  namespace           = "${local.common_name}/LiveStream"
  metric_name         = "RedisUnavailable"
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
  }
}

resource "aws_cloudwatch_metric_alarm" "live_stream_recovery_rate" {
  alarm_name          = "${local.common_name}-chat-api-live-stream-recovery-rate"
  alarm_description   = "chat-api is sending elevated permanent-history recovery responses; chat-api owns reconnect and recovery responses. See docs/runbooks/live-stream.md."
  namespace           = "${local.common_name}/LiveStream"
  metric_name         = "RecoveryResponses"
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
    Service = "chat-api"
    Result  = "history_410"
  }
}

resource "aws_cloudwatch_metric_alarm" "live_stream_capacity_bound" {
  alarm_name          = "${local.common_name}-agent-worker-live-stream-capacity-bound"
  alarm_description   = "Live Stream capacity bounds are repeatedly exhausted; agent-worker owns Live Stream production. See docs/runbooks/live-stream.md."
  namespace           = "${local.common_name}/LiveStream"
  metric_name         = "CapacityFailures"
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
    Service = "agent-worker"
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
