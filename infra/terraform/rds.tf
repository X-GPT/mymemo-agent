resource "aws_security_group_rule" "agent_services_to_kb_db" {
  type                     = "ingress"
  description              = "Agent Runtimes to existing KB Postgres"
  security_group_id        = var.kb_database_security_group_id
  source_security_group_id = aws_security_group.runtime.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}
