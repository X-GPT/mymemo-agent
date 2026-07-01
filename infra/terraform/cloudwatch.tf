resource "aws_cloudwatch_log_group" "chat_api" {
  name              = "/ecs/${local.chat_api_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "agent_worker" {
  name              = "/ecs/${local.agent_worker_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_metric_alarm" "chat_api_unhealthy" {
  count = var.enable_alb_routing ? 1 : 0

  alarm_name          = "${local.chat_api_name}-unhealthy-hosts"
  alarm_description   = "chat-api has unhealthy targets behind the existing MyMemo ALB."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    TargetGroup = aws_lb_target_group.chat_api[0].arn_suffix
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
    ClusterName = data.terraform_remote_state.mymemo_service.outputs.ecs_cluster_name
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
    ClusterName = data.terraform_remote_state.mymemo_service.outputs.ecs_cluster_name
    ServiceName = aws_ecs_service.agent_worker.name
  }
}
