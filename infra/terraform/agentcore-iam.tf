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
  name               = "${local.agentcore_name_prefix}-runtime"
  assume_role_policy = data.aws_iam_policy_document.runtime_trust.json
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid       = "PullFromRuntimeRepoOnly"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [data.aws_ecr_repository.production_runtime.arn]
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
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/objects/*"]
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
  name   = "${local.agentcore_name_prefix}-runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

data "aws_iam_policy_document" "query_runtime_trust" {
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
      values   = ["arn:aws:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:runtime/mymemo_agent_query_${var.environment}-*"]
    }
  }
}

resource "aws_iam_role" "query_runtime" {
  name               = "${local.agentcore_name_prefix}-query-runtime"
  assume_role_policy = data.aws_iam_policy_document.query_runtime_trust.json
}

data "aws_iam_policy_document" "query_runtime" {
  statement {
    sid = "PullFromQueryRuntimeRepoOnly"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [data.aws_ecr_repository.agent_query_runtime.arn]
  }

  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadCurrentOpenRouterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.openrouter_api_key_secret_arn]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }

  statement {
    sid = "ReadWriteAgentSessions"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/agent-sessions/*"]
  }

  statement {
    sid = "ManageRuntimeLogGroup"
    actions = [
      "logs:CreateLogGroup",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/mymemo_agent_query_${var.environment}-*"]
  }

  statement {
    sid       = "ConfigureRuntimeLogPolicy"
    actions   = ["logs:PutResourcePolicy"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/mymemo_agent_query_${var.environment}-*"]
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
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/mymemo_agent_query_${var.environment}-*:log-stream:*"]
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
    sid       = "RuntimeMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore"]
    }
  }

  statement {
    sid       = "DenyUserDelegatedAgentCoreInvocation"
    effect    = "Deny"
    actions   = ["bedrock-agentcore:InvokeAgentRuntimeForUser"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "query_runtime" {
  name   = "${local.agentcore_name_prefix}-query-runtime"
  role   = aws_iam_role.query_runtime.id
  policy = data.aws_iam_policy_document.query_runtime.json
}

resource "aws_iam_role" "consumer" {
  name               = "${local.agentcore_name_prefix}-consumer"
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
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.agentcore_name_prefix}-*"]
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.agentcore_name_prefix}-*:*"]
  }

  statement {
    sid       = "DescribeAgentDatabasePassword"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [local.agent_db_password_base_secret_arn]
  }

  statement {
    sid       = "ReadCurrentAgentDatabasePassword"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.agent_db_password_base_secret_arn]

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
  name   = "${local.agentcore_name_prefix}-consumer-base"
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
  name   = "${local.agentcore_name_prefix}-consumer"
  role   = aws_iam_role.consumer.id
  policy = data.aws_iam_policy_document.consumer.json
}
