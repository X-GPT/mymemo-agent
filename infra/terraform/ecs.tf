resource "aws_ecs_task_definition" "chat_api" {
  family                   = local.chat_api_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.chat_api_cpu
  memory                   = var.chat_api_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "chat-api"
      image     = var.chat_api_image
      essential = true
      portMappings = [
        {
          containerPort = var.chat_api_port
          hostPort      = var.chat_api_port
          protocol      = "tcp"
        }
      ]
      environment = local.chat_api_environment
      secrets     = local.chat_api_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.chat_api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "chat-api"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "bun -e \"const r=await fetch('http://127.0.0.1:${var.chat_api_port}/health'); if(!r.ok) process.exit(1)\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])
}

resource "aws_ecs_task_definition" "agent_worker" {
  family                   = local.agent_worker_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.agent_worker_cpu
  memory                   = var.agent_worker_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "agent-worker"
      image     = var.agent_worker_image
      essential = true
      portMappings = [
        {
          containerPort = var.agent_worker_port
          hostPort      = var.agent_worker_port
          protocol      = "tcp"
        }
      ]
      environment = local.agent_worker_environment
      secrets     = local.agent_worker_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.agent_worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "agent-worker"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "bun -e \"const r=await fetch('http://127.0.0.1:${var.agent_worker_port}/health'); if(!r.ok) process.exit(1)\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])
}

resource "aws_ecs_task_definition" "agent_migration" {
  family                   = "${local.common_name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "agent-migration"
      image     = var.chat_api_image
      essential = true
      command   = ["bun", "run", "db:migrate"]
      environment = concat([
        { name = "DB_SSL", value = var.db_ssl },
      ], local.agent_database_url_environment)
      secrets = local.agent_db_password_secret
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.chat_api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "agent-migration"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "chat_api" {
  name            = local.chat_api_name
  cluster         = local.shared_ecs_cluster_arn
  task_definition = aws_ecs_task_definition.chat_api.arn
  desired_count   = var.chat_api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.shared_ecs_subnet_ids
    security_groups  = [aws_security_group.services.id]
    assign_public_ip = var.assign_public_ip
  }

  dynamic "load_balancer" {
    for_each = var.enable_alb_routing ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.chat_api[0].arn
      container_name   = "chat-api"
      container_port   = var.chat_api_port
    }
  }

}

resource "aws_ecs_service" "agent_worker" {
  name            = local.agent_worker_name
  cluster         = local.shared_ecs_cluster_arn
  task_definition = aws_ecs_task_definition.agent_worker.arn
  desired_count   = var.agent_worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.shared_ecs_subnet_ids
    security_groups  = [aws_security_group.services.id]
    assign_public_ip = var.assign_public_ip
  }

}
