resource "aws_lb" "agent" {
  name               = substr(replace(local.alb_name, "_", "-"), 0, 32)
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.shared_ecs_subnet_ids
}

resource "aws_lb_target_group" "chat_api" {
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

resource "aws_lb_listener" "http" {
  count = var.agent_alb_certificate_arn == null ? 1 : 0

  load_balancer_arn = aws_lb.agent.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.chat_api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count = var.agent_alb_certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.agent.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.agent_alb_certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.agent.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.agent_alb_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.chat_api.arn
  }
}
