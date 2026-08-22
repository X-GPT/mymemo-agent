resource "aws_ecs_task_definition" "chat_api" {
  family                   = local.chat_api_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.chat_api_cpu
  memory                   = var.chat_api_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.chat_api_task.arn

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
  task_role_arn            = aws_iam_role.agent_worker_task.arn

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

resource "aws_ecs_task_definition" "agent_maintenance" {
  family                   = local.agent_maintenance_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.agent_maintenance_cpu
  memory                   = var.agent_maintenance_memory
  execution_role_arn       = aws_iam_role.agent_maintenance_execution.arn
  task_role_arn            = aws_iam_role.agent_maintenance_task.arn

  container_definitions = jsonencode([
    {
      name        = "agent-maintenance"
      image       = var.agent_maintenance_image
      essential   = true
      stopTimeout = 30
      portMappings = [
        {
          containerPort = var.agent_maintenance_port
          hostPort      = var.agent_maintenance_port
          protocol      = "tcp"
        }
      ]
      environment = local.agent_maintenance_environment
      secrets     = local.agent_maintenance_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.agent_maintenance.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "agent-maintenance"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "bun -e \"const r=await fetch('http://127.0.0.1:${var.agent_maintenance_port}/health'); if(!r.ok) process.exit(1)\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])
}

resource "aws_ecs_task_definition" "agentcore_dispatch_publisher" {
  family                   = local.agentcore_dispatch_publisher_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.agentcore_dispatch_publisher_cpu
  memory                   = var.agentcore_dispatch_publisher_memory
  execution_role_arn       = aws_iam_role.agentcore_dispatch_publisher_execution.arn
  task_role_arn            = aws_iam_role.agentcore_dispatch_publisher_task.arn

  container_definitions = jsonencode([
    {
      name        = "agentcore-dispatch-publisher"
      image       = var.agentcore_dispatch_publisher_image
      essential   = true
      stopTimeout = 30
      environment = local.agentcore_dispatch_publisher_environment
      secrets     = local.agentcore_dispatch_publisher_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.agentcore_dispatch_publisher.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "agentcore-dispatch-publisher"
        }
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
  task_role_arn            = aws_iam_role.agent_migration_task.arn

  container_definitions = jsonencode([
    {
      name       = "agent-migration"
      image      = var.chat_api_image
      essential  = true
      entryPoint = ["bun", "run"]
      command    = ["db:migrate"]
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
    security_groups  = [aws_security_group.services.id, aws_security_group.live_redis_clients.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.chat_api.arn
    container_name   = "chat-api"
    container_port   = var.chat_api_port
  }

  lifecycle {
    ignore_changes = [task_definition]
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
    security_groups  = [aws_security_group.services.id, aws_security_group.live_redis_clients.id]
    assign_public_ip = var.assign_public_ip
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "agent_maintenance" {
  name            = local.agent_maintenance_name
  cluster         = local.shared_ecs_cluster_arn
  task_definition = aws_ecs_task_definition.agent_maintenance.arn
  desired_count   = var.agent_maintenance_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.shared_ecs_subnet_ids
    security_groups  = [aws_security_group.agent_maintenance.id]
    assign_public_ip = var.assign_public_ip
  }

  lifecycle {
    ignore_changes = [task_definition]

    precondition {
      condition     = var.agent_maintenance_desired_count == 0 || var.agent_worker_desired_count == 0
      error_message = "agent-maintenance and agent-worker cannot both have a nonzero desired count; follow the controlled handoff runbook."
    }
  }
}

resource "aws_ecs_service" "agentcore_dispatch_publisher" {
  name            = local.agentcore_dispatch_publisher_name
  cluster         = local.shared_ecs_cluster_arn
  task_definition = aws_ecs_task_definition.agentcore_dispatch_publisher.arn
  desired_count   = var.agentcore_dispatch_publisher_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.agentcore_dispatch_publisher.id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}
