# Keep v1's inline policy intact and below IAM's 10,240-character role limit.
data "aws_iam_policy_document" "simplified_chat" {
  statement {
    sid       = "ConversationTableManagement"
    actions   = ["dynamodb:*"]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/mymemo-agent-*-conversations"]
  }

  statement {
    sid = "FrontFunctionManagement"
    actions = [
      "lambda:*FunctionUrlConfig*",
      "lambda:AddPermission",
      "lambda:CreateFunction",
      "lambda:DeleteFunction",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConcurrency",
      "lambda:GetFunctionConfiguration",
      "lambda:GetPolicy",
      "lambda:ListTags",
      "lambda:ListVersionsByFunction",
      "lambda:RemovePermission",
      "lambda:TagResource",
      "lambda:UntagResource",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
    ]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:mymemo-agent-*-front"]
  }

  # CreateCodeInterpreter has no resource-level authorization; Get/Delete do.
  # https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html
  statement {
    sid       = "CodeInterpreterCreation"
    actions   = ["bedrock-agentcore:CreateCodeInterpreter"]
    resources = ["*"]
  }

  statement {
    sid       = "CodeInterpreterManagement"
    actions   = ["bedrock-agentcore:*CodeInterpreter*"]
    resources = ["arn:aws:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:code-interpreter-custom/*"]
  }

  statement {
    sid       = "SweepScheduleManagement"
    actions   = ["scheduler:*"]
    resources = ["arn:aws:scheduler:${var.aws_region}:${var.aws_account_id}:schedule/default/mymemo-agent-*-sweep"]
  }

  statement {
    sid = "WorkspaceBucketManagement"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:DeleteBucketPolicy",
      "s3:GetAccelerateConfiguration",
      "s3:GetBucket*",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketTagging",
      "s3:PutBucketVersioning",
      "s3:PutEncryptionConfiguration",
      "s3:PutLifecycleConfiguration",
    ]
    resources = ["arn:aws:s3:::mymemo-agent-*-workspace"]
  }
}

resource "aws_iam_policy" "simplified_chat" {
  name   = "${var.deploy_role_name}-simplified-chat"
  policy = data.aws_iam_policy_document.simplified_chat.json
}

resource "aws_iam_role_policy_attachment" "simplified_chat" {
  role       = aws_iam_role.github_actions_deploy.name
  policy_arn = aws_iam_policy.simplified_chat.arn
}
