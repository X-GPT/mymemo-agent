data "aws_iam_policy_document" "agent_runtime_trust" {
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
      values   = ["arn:aws:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:runtime/mymemo_agent_${var.environment}-*"]
    }
  }
}

resource "aws_iam_role" "agent_runtime" {
  name               = "${local.common_name}-runtime"
  assume_role_policy = data.aws_iam_policy_document.agent_runtime_trust.json
}

data "aws_iam_policy_document" "agent_runtime" {
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [data.aws_ecr_repository.agent_runtime.arn]
  }
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      local.openrouter_api_key_secret_arn,
      local.kb_database_url_secret_arn,
    ]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }
  statement {
    actions = [
      "bedrock-agentcore:InvokeCodeInterpreter",
      "bedrock-agentcore:GetCodeInterpreterSession",
    ]
    resources = [aws_bedrockagentcore_code_interpreter.hand.code_interpreter_arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.workspace.arn}/_transcripts/*"]
  }
  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:*"]
  }
  statement {
    actions   = ["logs:DescribeLogStreams"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/mymemo_agent_${var.environment}-*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/mymemo_agent_${var.environment}-*:log-stream:*"]
  }
  statement {
    actions = [
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "agent_runtime" {
  name   = "${local.common_name}-runtime"
  role   = aws_iam_role.agent_runtime.id
  policy = data.aws_iam_policy_document.agent_runtime.json
}
