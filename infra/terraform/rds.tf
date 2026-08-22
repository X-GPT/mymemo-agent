resource "aws_security_group" "agent_db" {
  name        = "${local.common_name}-db"
  description = "mymemo-agent dedicated Postgres database"
  vpc_id      = local.shared_vpc_id
}

resource "aws_security_group_rule" "agent_services_to_agent_db" {
  type                     = "ingress"
  description              = "Agent ECS services to dedicated agent Postgres"
  security_group_id        = aws_security_group.agent_db.id
  source_security_group_id = aws_security_group.services.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "agentcore_dispatch_publisher_to_agent_db" {
  type                     = "ingress"
  description              = "AgentCore dispatch publisher to dedicated agent Postgres"
  security_group_id        = aws_security_group.agent_db.id
  source_security_group_id = aws_security_group.agentcore_dispatch_publisher.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "agent_maintenance_to_agent_db" {
  type                     = "ingress"
  description              = "Agent maintenance to dedicated agent Postgres"
  security_group_id        = aws_security_group.agent_db.id
  source_security_group_id = aws_security_group.agent_maintenance.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

# The KB database lives in the existing mymemo-service RDS instance, whose
# security group is owned by that stack and admits only its own ECS tasks.
# AgentCore Runtime reads the KB over KB_DATABASE_URL, so this stack attaches the
# one ingress rule that lets agent services reach it.
resource "aws_security_group_rule" "agent_services_to_kb_db" {
  type                     = "ingress"
  description              = "Agent ECS services to existing KB Postgres (worker document search)"
  security_group_id        = var.kb_database_security_group_id
  source_security_group_id = aws_security_group.services.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_db_subnet_group" "agent" {
  name       = "${local.common_name}-db"
  subnet_ids = local.shared_ecs_subnet_ids
}

resource "aws_db_instance" "agent" {
  identifier = "${local.common_name}-db"

  engine         = "postgres"
  engine_version = var.agent_db_engine_version
  instance_class = var.agent_db_instance_class

  db_name  = var.agent_database_name
  username = var.agent_database_username

  manage_master_user_password = true

  allocated_storage     = var.agent_db_allocated_storage_gb
  max_allocated_storage = var.agent_db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  backup_retention_period = var.agent_db_backup_retention_days
  deletion_protection     = var.agent_db_deletion_protection
  skip_final_snapshot     = false
  final_snapshot_identifier = replace(
    "${local.common_name}-db-final",
    "_",
    "-",
  )

  db_subnet_group_name   = aws_db_subnet_group.agent.name
  vpc_security_group_ids = [aws_security_group.agent_db.id]
  publicly_accessible    = false

  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
}
