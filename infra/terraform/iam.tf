data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.common_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      local.agent_db_password_base_secret_arn,
      local.statsig_server_secret_arn,
      local.live_redis_url_secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_read_secrets" {
  name   = "${local.common_name}-read-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_role" "agent_migration_execution" {
  name               = "${local.common_name}-migration-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy_attachment" "agent_migration_execution" {
  role       = aws_iam_role.agent_migration_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "agent_migration_read_database_secret" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [local.agent_db_password_base_secret_arn]
  }
}

resource "aws_iam_role_policy" "agent_migration_read_database_secret" {
  name   = "${local.common_name}-migration-read-database-secret"
  role   = aws_iam_role.agent_migration_execution.id
  policy = data.aws_iam_policy_document.agent_migration_read_database_secret.json
}

resource "aws_iam_role" "agentcore_dispatch_publisher_execution" {
  name               = "${local.common_name}-agentcore-dispatch-publisher-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy_attachment" "agentcore_dispatch_publisher_execution" {
  role       = aws_iam_role.agentcore_dispatch_publisher_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "agentcore_dispatch_publisher_read_database_secret" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [local.agent_db_password_base_secret_arn]
  }
}

resource "aws_iam_role_policy" "agentcore_dispatch_publisher_read_database_secret" {
  name   = "${local.common_name}-agentcore-dispatch-publisher-read-database-secret"
  role   = aws_iam_role.agentcore_dispatch_publisher_execution.id
  policy = data.aws_iam_policy_document.agentcore_dispatch_publisher_read_database_secret.json
}

resource "aws_iam_role" "agent_maintenance_execution" {
  name               = "${local.agent_maintenance_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy_attachment" "agent_maintenance_execution" {
  role       = aws_iam_role.agent_maintenance_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "agent_maintenance_read_secrets" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      local.agent_db_password_base_secret_arn,
      local.e2b_api_key_secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "agent_maintenance_read_secrets" {
  name   = "${local.agent_maintenance_name}-read-secrets"
  role   = aws_iam_role.agent_maintenance_execution.id
  policy = data.aws_iam_policy_document.agent_maintenance_read_secrets.json
}

resource "aws_iam_role" "chat_api_task" {
  name               = "${local.common_name}-chat-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

data "aws_iam_policy_document" "chat_api_artifact_read" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/objects/*"]
  }
}

resource "aws_iam_role_policy" "chat_api_artifact_read" {
  name   = "${local.common_name}-artifact-read"
  role   = aws_iam_role.chat_api_task.id
  policy = data.aws_iam_policy_document.chat_api_artifact_read.json
}

resource "aws_iam_role" "agent_maintenance_task" {
  name               = "${local.agent_maintenance_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

data "aws_iam_policy_document" "agent_maintenance_artifact_delete" {
  statement {
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/objects/*"]
  }
}

resource "aws_iam_role_policy" "agent_maintenance_artifact_delete" {
  name   = "${local.agent_maintenance_name}-artifact-delete"
  role   = aws_iam_role.agent_maintenance_task.id
  policy = data.aws_iam_policy_document.agent_maintenance_artifact_delete.json
}

resource "aws_iam_role" "agentcore_dispatch_publisher_task" {
  name               = "${local.common_name}-agentcore-dispatch-publisher-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

data "aws_iam_policy_document" "agentcore_dispatch_publisher" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [local.agentcore_dispatch_enabled_parameter_arn]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [local.agentcore_dispatch_queue_arn]
  }

  statement {
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.dispatch.arn]
  }
}

resource "aws_iam_role_policy" "agentcore_dispatch_publisher" {
  name   = "${local.common_name}-agentcore-dispatch-publisher"
  role   = aws_iam_role.agentcore_dispatch_publisher_task.id
  policy = data.aws_iam_policy_document.agentcore_dispatch_publisher.json
}
