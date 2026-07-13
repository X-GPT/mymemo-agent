resource "aws_security_group" "database_access" {
  name        = "${local.common_name}-db-access"
  description = "EC2 Instance Connect access to the agent and KB databases"
  vpc_id      = local.shared_vpc_id
}

resource "aws_security_group" "database_bridge" {
  name        = "${local.common_name}-db-bridge"
  description = "Private SSH bridge from EC2 Instance Connect to the agent and KB databases"
  vpc_id      = local.shared_vpc_id
}

resource "aws_security_group_rule" "database_access_to_bridge" {
  type                     = "egress"
  description              = "EC2 Instance Connect to the private database bridge"
  security_group_id        = aws_security_group.database_access.id
  source_security_group_id = aws_security_group.database_bridge.id
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "database_bridge_from_access" {
  type                     = "ingress"
  description              = "SSH through EC2 Instance Connect"
  security_group_id        = aws_security_group.database_bridge.id
  source_security_group_id = aws_security_group.database_access.id
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "database_access_to_agent_db" {
  type                     = "egress"
  description              = "Private database bridge to dedicated agent Postgres"
  security_group_id        = aws_security_group.database_bridge.id
  source_security_group_id = aws_security_group.agent_db.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "database_access_to_kb_db" {
  type                     = "egress"
  description              = "Private database bridge to existing KB Postgres"
  security_group_id        = aws_security_group.database_bridge.id
  source_security_group_id = var.kb_database_security_group_id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "agent_db_from_database_access" {
  type                     = "ingress"
  description              = "Operator access through the private database bridge"
  security_group_id        = aws_security_group.agent_db.id
  source_security_group_id = aws_security_group.database_bridge.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "kb_db_from_database_access" {
  type                     = "ingress"
  description              = "Operator access through the private database bridge"
  security_group_id        = var.kb_database_security_group_id
  source_security_group_id = aws_security_group.database_bridge.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_ec2_instance_connect_endpoint" "database_access" {
  subnet_id          = sort(local.shared_ecs_subnet_ids)[0]
  security_group_ids = [aws_security_group.database_access.id]
  preserve_client_ip = false

  tags = {
    Name = "${local.common_name}-db-access"
  }
}

data "aws_ami" "database_bridge" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "database_bridge" {
  ami                         = data.aws_ami.database_bridge.id
  instance_type               = "t4g.nano"
  subnet_id                   = sort(local.shared_ecs_subnet_ids)[0]
  vpc_security_group_ids      = [aws_security_group.database_bridge.id]
  associate_public_ip_address = false

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    delete_on_termination = true
    encrypted             = true
    volume_size           = 8
    volume_type           = "gp3"
  }

  tags = {
    Name = "${local.common_name}-db-bridge"
  }
}
