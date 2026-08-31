# /v2 Lambda MicroVM topology (spec #654, ticket #660).
#
# One persistent MicroVM per Conversation runs the Claude Agent SDK in-VM. The
# VM's only network paths are expressed here: a VPC egress connector into
# no-NAT private subnets whose security group reaches exactly {RDS, Redis, the
# gateway route on the internal ALB} plus VPC DNS. No NAT, no IGW route, no
# Network Firewall — full routing through the connector was verified live on
# the map (#644/#646). Quota bumps (RunMicrovm TPS, regional MicroVM memory)
# are manual steps in docs/runbooks/microvm-v2-topology.md, not resources.

locals {
  microvm_name = "${local.common_name}-microvm"

  microvm_private_subnets = {
    for index, availability_zone in var.availability_zones : availability_zone => {
      availability_zone = availability_zone
      cidr_block        = var.microvm_private_subnet_cidrs[index]
    }
  }
}

# --- No-NAT private subnets -------------------------------------------------
# Route tables carry only the implicit VPC-local route: internet-bound packets
# have nowhere to go. That absence is the egress lockdown's routing half.

resource "aws_subnet" "microvm_private" {
  for_each = local.microvm_private_subnets

  vpc_id                  = local.shared_vpc_id
  availability_zone       = each.value.availability_zone
  cidr_block              = each.value.cidr_block
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.microvm_name}-private-${each.key}"
  }
}

resource "aws_route_table" "microvm_private" {
  for_each = local.microvm_private_subnets

  vpc_id = local.shared_vpc_id

  tags = {
    Name = "${local.microvm_name}-private-${each.key}"
  }
}

resource "aws_route_table_association" "microvm_private" {
  for_each = local.microvm_private_subnets

  subnet_id      = aws_subnet.microvm_private[each.key].id
  route_table_id = aws_route_table.microvm_private[each.key].id
}

# --- Security group: the SG half of "egress reaches only RDS, Redis, Gateway" -

# All rules are standalone so this group can reference the ALB group while
# the ALB group's inline ingress references it back (inline both ways is a
# Terraform graph cycle).
resource "aws_security_group" "microvm_vm" {
  name        = "${local.microvm_name}-vm"
  description = "MicroVM egress connector ENIs - outbound only to RDS, Redis, and the gateway"
  vpc_id      = local.shared_vpc_id
}

resource "aws_security_group_rule" "microvm_egress_agent_db" {
  type                     = "egress"
  description              = "Dedicated agent Postgres"
  security_group_id        = aws_security_group.microvm_vm.id
  source_security_group_id = aws_security_group.agent_db.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "microvm_egress_kb_db" {
  type                     = "egress"
  description              = "Existing KB Postgres (in-VM doc tools run direct KB SQL)"
  security_group_id        = aws_security_group.microvm_vm.id
  source_security_group_id = var.kb_database_security_group_id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "microvm_egress_live_redis" {
  type                     = "egress"
  description              = "Redis Live Stream relay (UIMessage pub/sub)"
  security_group_id        = aws_security_group.microvm_vm.id
  source_security_group_id = aws_security_group.live_redis.id
  from_port                = var.live_redis_port
  to_port                  = var.live_redis_port
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "microvm_egress_gateway" {
  type                     = "egress"
  description              = "Credential-injecting gateway route on the internal agent ALB"
  security_group_id        = aws_security_group.microvm_vm.id
  source_security_group_id = aws_security_group.alb.id
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "microvm_egress_dns_udp" {
  type              = "egress"
  description       = "VPC DNS over UDP"
  security_group_id = aws_security_group.microvm_vm.id
  cidr_blocks       = [data.aws_vpc.shared.cidr_block]
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
}

resource "aws_security_group_rule" "microvm_egress_dns_tcp" {
  type              = "egress"
  description       = "VPC DNS over TCP"
  security_group_id = aws_security_group.microvm_vm.id
  cidr_blocks       = [data.aws_vpc.shared.cidr_block]
  from_port         = 53
  to_port           = 53
  protocol          = "tcp"
}

resource "aws_security_group_rule" "microvm_to_agent_db" {
  type                     = "ingress"
  description              = "MicroVM Conversations to dedicated agent Postgres"
  security_group_id        = aws_security_group.agent_db.id
  source_security_group_id = aws_security_group.microvm_vm.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "microvm_to_kb_db" {
  type                     = "ingress"
  description              = "MicroVM Conversations to existing KB Postgres (in-VM doc tools)"
  security_group_id        = var.kb_database_security_group_id
  source_security_group_id = aws_security_group.microvm_vm.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
}

resource "aws_security_group_rule" "microvm_to_live_redis" {
  type                     = "ingress"
  description              = "MicroVM Conversations to the Redis Live Stream"
  security_group_id        = aws_security_group.live_redis.id
  source_security_group_id = aws_security_group.microvm_vm.id
  from_port                = var.live_redis_port
  to_port                  = var.live_redis_port
  protocol                 = "tcp"
}

# --- VPC egress connector ---------------------------------------------------

data "aws_iam_policy_document" "microvm_connector_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "microvm_connector_operator" {
  name               = "${local.microvm_name}-connector-operator"
  assume_role_policy = data.aws_iam_policy_document.microvm_connector_assume_role.json
}

data "aws_iam_policy_document" "microvm_connector_operator" {
  statement {
    sid = "ManageConnectorEnis"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "microvm_connector_operator" {
  name   = "${local.microvm_name}-connector-operator"
  role   = aws_iam_role.microvm_connector_operator.id
  policy = data.aws_iam_policy_document.microvm_connector_operator.json
}

resource "aws_lambdacore_network_connector" "microvm_egress" {
  name          = "${local.microvm_name}-egress"
  operator_role = aws_iam_role.microvm_connector_operator.arn

  configuration {
    vpc_egress_configuration {
      subnet_ids                        = [for subnet in aws_subnet.microvm_private : subnet.id]
      security_group_ids                = [aws_security_group.microvm_vm.id]
      network_protocol                  = "IPv4"
      associated_compute_resource_types = ["MicroVm"]
    }
  }
}

# --- Checkpoint bucket ------------------------------------------------------
# Checkpoints live under conversations/<conversation-id>/ and must survive
# arbitrarily long idle Conversations (lazy rehydrate), so no expiration rule:
# deletion is explicit via the pending_cleanup outbox. Lifecycle only bounds
# multipart-upload debris and cold-storage cost.

resource "aws_s3_bucket" "microvm_checkpoints" {
  bucket = "${local.microvm_name}-checkpoints"
}

resource "aws_s3_bucket_public_access_block" "microvm_checkpoints" {
  bucket = aws_s3_bucket.microvm_checkpoints.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "microvm_checkpoints" {
  bucket = aws_s3_bucket.microvm_checkpoints.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "microvm_checkpoints" {
  bucket = aws_s3_bucket.microvm_checkpoints.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "microvm_checkpoints" {
  bucket = aws_s3_bucket.microvm_checkpoints.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "microvm_checkpoints" {
  bucket = aws_s3_bucket.microvm_checkpoints.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "checkpoints-to-infrequent-access"
    status = "Enabled"

    filter {
      prefix = "conversations/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

data "aws_iam_policy_document" "microvm_checkpoints_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.microvm_checkpoints.arn,
      "${aws_s3_bucket.microvm_checkpoints.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "microvm_checkpoints_tls_only" {
  bucket = aws_s3_bucket.microvm_checkpoints.id
  policy = data.aws_iam_policy_document.microvm_checkpoints_tls_only.json
}

# --- VM execution role ------------------------------------------------------
# Passed at RunMicrovm; scoped to the conversations/* prefix — the accepted
# residual in ADR-0034 (per-prefix, not per-Conversation, mitigated by the
# in-VM process boundary).

resource "aws_iam_role" "microvm_execution" {
  name               = "${local.microvm_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.microvm_connector_assume_role.json
}

data "aws_iam_policy_document" "microvm_execution_checkpoints" {
  statement {
    sid = "CheckpointObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.microvm_checkpoints.arn}/conversations/*"]
  }

  statement {
    sid       = "CheckpointList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.microvm_checkpoints.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["conversations/*"]
    }
  }
}

resource "aws_iam_role_policy" "microvm_execution_checkpoints" {
  name   = "${local.microvm_name}-execution-checkpoints"
  role   = aws_iam_role.microvm_execution.id
  policy = data.aws_iam_policy_document.microvm_execution_checkpoints.json
}

# --- chat-api control-plane grants ------------------------------------------
# Exactly the named control-plane actions plus the checkpoint-deletion S3
# scope; chat-api never reads or writes checkpoint content (data plane stays
# with the VM execution role). Suspend/Resume are deliberately absent — the
# platform idle policy owns them.

data "aws_iam_policy_document" "chat_api_microvm_control_plane" {
  statement {
    sid = "MicrovmControlPlane"
    actions = [
      "lambda:RunMicrovm",
      "lambda:CreateMicrovmAuthToken",
      "lambda:TerminateMicrovm",
    ]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:microvm:*",
      "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:microvm-image:*",
    ]
  }

  statement {
    sid       = "CheckpointCleanupDelete"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.microvm_checkpoints.arn}/conversations/*"]
  }

  statement {
    sid       = "CheckpointCleanupList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.microvm_checkpoints.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["conversations/*"]
    }
  }

  statement {
    sid       = "PassMicrovmExecutionRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.microvm_execution.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "chat_api_microvm_control_plane" {
  name   = "${local.microvm_name}-chat-api-control-plane"
  role   = aws_iam_role.chat_api_task.id
  policy = data.aws_iam_policy_document.chat_api_microvm_control_plane.json
}
