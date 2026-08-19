resource "aws_cloudwatch_log_group" "chat_api" {
  name              = "/ecs/${local.chat_api_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "agent_worker" {
  name              = "/ecs/${local.agent_worker_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "agentcore_dispatch_publisher" {
  name              = "/ecs/${local.agentcore_dispatch_publisher_name}"
  retention_in_days = var.log_retention_days
}

locals {
  live_stream_log_groups = {
    chat-api     = aws_cloudwatch_log_group.chat_api.name
    agent-worker = aws_cloudwatch_log_group.agent_worker.name
  }
}

resource "aws_cloudwatch_log_metric_filter" "live_stream_operations" {
  for_each = local.live_stream_log_groups

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
  for_each = local.live_stream_log_groups

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
  for_each = local.live_stream_log_groups

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
  for_each = local.live_stream_log_groups

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
