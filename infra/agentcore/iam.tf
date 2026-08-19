data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "runtime_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:runtime/mymemo_agentcore_prod-*"]
    }
  }
}

resource "aws_iam_role" "runtime" {
  name               = "${local.name_prefix}-runtime"
  assume_role_policy = data.aws_iam_policy_document.runtime_trust.json
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid       = "PullFromRuntimeRepoOnly"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.runtime.arn]
  }

  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadOnlyRequiredCurrentSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.exact_secret_arns

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }

  statement {
    sid       = "DescribeOnlyRequiredSecrets"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = local.exact_secret_arns
  }

  statement {
    sid       = "ReadFailClosedDispatchControl"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.dispatch_enabled.arn]
  }

  statement {
    sid = "WriteProductionArtifacts"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:PutObject",
    ]
    resources = ["arn:aws:s3:::${var.artifact_bucket_name}/objects/*"]
  }

  statement {
    sid = "ManageRuntimeLogGroup"
    actions = [
      "logs:CreateLogGroup",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/mymemo_agentcore_${var.environment}-*"]
  }

  statement {
    sid       = "ConfigureRuntimeLogPolicy"
    actions   = ["logs:PutResourcePolicy"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:*"]
  }

  statement {
    sid       = "DiscoverRuntimeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:*"]
  }

  statement {
    sid = "WriteRuntimeLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/mymemo_agentcore_${var.environment}-*:log-stream:*"]
  }

  statement {
    sid = "RuntimeTracing"
    actions = [
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "BoundedDispatchMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["MyMemo/AgentCoreDispatch"]
    }
  }

  statement {
    sid       = "DenyUserDelegatedAgentCoreInvocation"
    effect    = "Deny"
    actions   = ["bedrock-agentcore:InvokeAgentRuntimeForUser"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "${local.name_prefix}-runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

resource "aws_iam_role" "consumer" {
  name               = "${local.name_prefix}-consumer"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "lambda_base" {
  statement {
    sid = "VpcAttachment"
    actions = [
      "ec2:AssignPrivateIpAddresses",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSubnets",
      "ec2:UnassignPrivateIpAddresses",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "CreateFunctionLogGroups"
    actions   = ["logs:CreateLogGroup"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.name_prefix}-*"]
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.name_prefix}-*:*"]
  }

  statement {
    sid       = "DescribeAgentDatabaseUrl"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [var.agent_database_url_secret_arn]
  }

  statement {
    sid       = "ReadCurrentAgentDatabaseUrl"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.agent_database_url_secret_arn]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }

  statement {
    sid       = "ReadFailClosedDispatchControl"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.dispatch_enabled.arn]
  }

  statement {
    sid       = "DecryptDispatchQueue"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.dispatch.arn]
  }
}

resource "aws_iam_role_policy" "consumer_base" {
  name   = "${local.name_prefix}-consumer-base"
  role   = aws_iam_role.consumer.id
  policy = data.aws_iam_policy_document.lambda_base.json
}

data "aws_iam_policy_document" "consumer" {
  statement {
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.dispatch.arn]
  }

  statement {
    actions = ["bedrock-agentcore:InvokeAgentRuntime"]
    resources = [
      aws_bedrockagentcore_agent_runtime.runtime.agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.runtime.agent_runtime_arn}/runtime-endpoint/DEFAULT",
    ]
  }

  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["MyMemo/AgentCoreDispatch"]
    }
  }
}

resource "aws_iam_role_policy" "consumer" {
  name   = "${local.name_prefix}-consumer"
  role   = aws_iam_role.consumer.id
  policy = data.aws_iam_policy_document.consumer.json
}
