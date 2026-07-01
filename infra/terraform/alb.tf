resource "aws_lb_target_group" "chat_api" {
  count = var.enable_alb_routing ? 1 : 0

  name        = substr(replace(local.chat_api_name, "_", "-"), 0, 32)
  port        = var.chat_api_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.shared_vpc_id

  health_check {
    enabled             = true
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }
}

resource "aws_lb_listener_rule" "chat_api" {
  count = var.enable_alb_routing ? 1 : 0

  listener_arn = local.shared_alb_listener_arn
  priority     = var.chat_api_listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.chat_api[0].arn
  }

  condition {
    path_pattern {
      values = var.chat_api_path_patterns
    }
  }
}
