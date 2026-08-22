resource "aws_cloudwatch_log_group" "chat_api" {
  name              = "/ecs/${local.chat_api_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "agent_maintenance" {
  name              = "/ecs/${local.agent_maintenance_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_metric_filter" "agent_maintenance_errors" {
  name           = "${local.agent_maintenance_name}-errors"
  log_group_name = aws_cloudwatch_log_group.agent_maintenance.name
  pattern        = "{ $.level >= 50 }"

  metric_transformation {
    name      = "Errors"
    namespace = "${local.common_name}/Maintenance"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "agent_maintenance_errors" {
  alarm_name          = "${local.agent_maintenance_name}-errors"
  alarm_description   = "agent-maintenance logged a failed expiration, Reclamation, or cleanup operation."
  namespace           = "${local.common_name}/Maintenance"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_log_metric_filter" "agent_maintenance_heartbeat" {
  name           = "${local.agent_maintenance_name}-heartbeat"
  log_group_name = aws_cloudwatch_log_group.agent_maintenance.name
  pattern        = "{ $.message = \"maintenance liveness pass complete\" }"

  metric_transformation {
    name      = "Heartbeat"
    namespace = "${local.common_name}/Maintenance"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "agent_maintenance_heartbeat" {
  count = var.agent_maintenance_desired_count

  alarm_name          = "${local.agent_maintenance_name}-heartbeat"
  alarm_description   = "agent-maintenance has not completed a liveness pass for two minutes."
  namespace           = "${local.common_name}/Maintenance"
  metric_name         = "Heartbeat"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_log_group" "agentcore_dispatch_publisher" {
  name              = "/ecs/${local.agentcore_dispatch_publisher_name}"
  retention_in_days = var.log_retention_days
}

locals {
  live_stream_log_groups = {
    agentcore-runtime = "/aws/bedrock-agentcore/runtimes/${aws_bedrockagentcore_agent_runtime.runtime.agent_runtime_id}-DEFAULT"
    chat-api          = aws_cloudwatch_log_group.chat_api.name
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

  name           = "${local.common_name}-agentcore-runtime-live-stream-capacity-${replace(each.key, "_", "-")}"
  log_group_name = local.live_stream_log_groups["agentcore-runtime"]
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"agentcore-runtime\" && $.reason = \"${each.key}\" }"

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
  name           = "${local.common_name}-agentcore-runtime-live-stream-degraded-duration"
  log_group_name = local.live_stream_log_groups["agentcore-runtime"]
  pattern        = "{ $.message = \"Live Stream metric\" && $.service = \"agentcore-runtime\" && $.operation = \"degradation\" && $.result = \"ended\" && $.durationMs = * }"

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
  alarm_description   = "${each.key} has sustained Redis failures. See docs/runbooks/live-stream.md."
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
  alarm_name          = "${local.common_name}-agentcore-runtime-live-stream-capacity-bound"
  alarm_description   = "Live Stream capacity bounds are repeatedly exhausted in AgentCore Runtime. See docs/runbooks/live-stream.md."
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
    Service = "agentcore-runtime"
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
