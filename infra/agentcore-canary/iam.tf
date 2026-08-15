data "aws_iam_openid_connect_provider" "github" {
  arn = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
}

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
      values   = ["arn:aws:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:runtime/mymemo_agentcore_canary_prod-*"]
    }
  }
}

data "aws_iam_policy_document" "states_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.name_prefix}-*"]
    }
  }
}

data "aws_iam_policy_document" "github_operator_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_owner}/${var.github_repository}:environment:production-agentcore-canary"]
    }
  }
}

resource "aws_iam_role" "runtime" {
  name               = "${local.name_prefix}-runtime"
  assume_role_policy = data.aws_iam_policy_document.runtime_trust.json
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid       = "PullFromCanaryRuntimeRepoOnly"
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
    sid       = "ReadFailClosedCanaryFlag"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.enabled.arn]
  }

  statement {
    sid       = "WriteSyntheticArtifactsOnly"
    actions   = ["s3:AbortMultipartUpload", "s3:PutObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket_name}/objects/*"]
  }

  statement {
    sid = "RuntimeTelemetry"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "BoundedCanaryMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["MyMemo/AgentCoreCanary"]
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

resource "aws_iam_role" "publisher" {
  name               = "${local.name_prefix}-publisher"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "consumer" {
  name               = "${local.name_prefix}-consumer"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "control" {
  name               = "${local.name_prefix}-control"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "preflight" {
  name               = "${local.name_prefix}-preflight"
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
    sid = "FunctionLogs"
    actions = [
      "logs:CreateLogGroup",
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
    sid       = "ReadFailClosedCanaryFlag"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.enabled.arn]
  }

  statement {
    sid       = "DecryptCanaryQueue"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.canary.arn]
  }
}

data "aws_iam_policy_document" "preflight" {
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
    sid = "FunctionLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.name_prefix}-preflight:*"]
  }

  statement {
    sid       = "DescribePreflightDatabaseUrls"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [var.agent_database_url_secret_arn, var.kb_database_url_secret_arn]
  }

  statement {
    sid       = "ReadCurrentPreflightDatabaseUrls"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.agent_database_url_secret_arn, var.kb_database_url_secret_arn]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }
}

resource "aws_iam_role_policy" "preflight" {
  name   = "${local.name_prefix}-preflight"
  role   = aws_iam_role.preflight.id
  policy = data.aws_iam_policy_document.preflight.json
}

resource "aws_iam_role_policy" "publisher_base" {
  name   = "${local.name_prefix}-publisher-base"
  role   = aws_iam_role.publisher.id
  policy = data.aws_iam_policy_document.lambda_base.json
}

resource "aws_iam_role_policy" "consumer_base" {
  name   = "${local.name_prefix}-consumer-base"
  role   = aws_iam_role.consumer.id
  policy = data.aws_iam_policy_document.lambda_base.json
}

resource "aws_iam_role_policy" "control_base" {
  name   = "${local.name_prefix}-control-base"
  role   = aws_iam_role.control.id
  policy = data.aws_iam_policy_document.lambda_base.json
}

data "aws_iam_policy_document" "publisher" {
  statement {
    actions   = ["sqs:GetQueueAttributes", "sqs:SendMessage"]
    resources = [aws_sqs_queue.dispatch.arn]
  }

  statement {
    actions   = ["kms:GenerateDataKey"]
    resources = [aws_kms_key.canary.arn]
  }
}

resource "aws_iam_role_policy" "publisher" {
  name   = "${local.name_prefix}-publisher"
  role   = aws_iam_role.publisher.id
  policy = data.aws_iam_policy_document.publisher.json
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
      aws_bedrockagentcore_agent_runtime.canary.agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.canary.agent_runtime_arn}/runtime-endpoint/DEFAULT",
    ]
  }

  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["MyMemo/AgentCoreCanary"]
    }
  }
}

resource "aws_iam_role_policy" "consumer" {
  name   = "${local.name_prefix}-consumer"
  role   = aws_iam_role.consumer.id
  policy = data.aws_iam_policy_document.consumer.json
}

data "aws_iam_policy_document" "control" {
  statement {
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [var.kb_database_url_secret_arn]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.kb_database_url_secret_arn]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }

  statement {
    actions   = ["sqs:GetQueueAttributes", "sqs:SendMessage"]
    resources = [aws_sqs_queue.dispatch.arn]
  }

  statement {
    actions   = ["kms:GenerateDataKey"]
    resources = [aws_kms_key.canary.arn]
  }
}

resource "aws_iam_role_policy" "control" {
  name   = "${local.name_prefix}-control"
  role   = aws_iam_role.control.id
  policy = data.aws_iam_policy_document.control.json
}

resource "aws_iam_role" "deployment" {
  name               = "${local.name_prefix}-deployment"
  assume_role_policy = data.aws_iam_policy_document.github_operator_trust.json
}

data "aws_iam_policy_document" "deployment" {
  statement {
    sid = "DedicatedTerraformStateBucket"
    actions = [
      "s3:GetBucketVersioning",
      "s3:ListBucket",
    ]
    resources = ["arn:aws:s3:::mymemo-terraform-state-bucket"]
  }

  statement {
    sid       = "DedicatedTerraformState"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["arn:aws:s3:::mymemo-terraform-state-bucket/mymemo-agent/agentcore-canary-prod.tfstate"]
  }

  statement {
    sid       = "DedicatedTerraformLock"
    actions   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
    resources = ["arn:aws:s3:::mymemo-terraform-state-bucket/mymemo-agent/agentcore-canary-prod.tfstate.tflock"]
  }

  statement {
    sid       = "ReadOnlySharedTerraformOutputs"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::mymemo-terraform-state-bucket/mymemo-agent/prod.tfstate"]
  }

  statement {
    sid = "ReadCanaryControlPlane"
    actions = [
      "bedrock-agentcore:GetAgentRuntime",
      "bedrock-agentcore:GetAgentRuntimeEndpoint",
      "bedrock-agentcore:ListAgentRuntimeEndpoints",
      "bedrock-agentcore:ListAgentRuntimeVersions",
      "bedrock-agentcore:ListTagsForResource",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListTagsForResource",
      "ec2:Describe*",
      "ecr:GetAuthorizationToken",
      "events:DescribeRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
      "iam:GetOpenIDConnectProvider",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListAliases",
      "kms:ListResourceTags",
      "lambda:GetEventSourceMapping",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConcurrency",
      "lambda:GetFunctionConfiguration",
      "lambda:GetPolicy",
      "lambda:GetRuntimeManagementConfig",
      "lambda:ListEventSourceMappings",
      "lambda:ListTags",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ListQueueTags",
      "ssm:DescribeParameters",
      "ssm:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ReadCanaryRepositoryOnly"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:ListImages",
      "ecr:ListTagsForResource",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/mymemo/agentcore-canary-runtime"]
  }

  statement {
    sid       = "ReadCanaryEnablementOnly"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/mymemo/agentcore-canary/${var.environment}/enabled"]
  }

  statement {
    sid = "ManageCanaryRuntimeOnly"
    actions = [
      "bedrock-agentcore:CreateAgentRuntime",
      "bedrock-agentcore:TagResource",
      "bedrock-agentcore:UpdateAgentRuntime",
    ]
    resources = ["arn:aws:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:runtime/mymemo_agentcore_canary_prod-*"]
  }

  statement {
    sid = "ManageCanaryAlarmsOnly"
    actions = [
      "cloudwatch:DeleteAlarms",
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:TagResource",
    ]
    resources = ["arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${local.name_prefix}-*"]
  }

  statement {
    sid = "ManageCanaryRepositoryOnly"
    actions = [
      "ecr:CompleteLayerUpload",
      "ecr:CreateRepository",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:PutImageScanningConfiguration",
      "ecr:PutImageTagMutability",
      "ecr:TagResource",
      "ecr:UploadLayerPart",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/mymemo/agentcore-canary-runtime"]
  }

  statement {
    sid       = "ManageCanaryRepairRuleOnly"
    actions   = ["events:DisableRule"]
    resources = ["arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.name_prefix}-repair"]
  }

  statement {
    sid       = "ManageCanaryRepairTargetOnly"
    actions   = ["events:PutTargets"]
    resources = ["arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.name_prefix}-repair"]

    condition {
      test     = "ForAnyValue:ArnEquals"
      variable = "events:TargetArn"
      values   = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name_prefix}-publisher"]
    }
  }

  statement {
    sid = "ManageCanaryFunctionsOnly"
    actions = [
      "lambda:CreateFunction",
      "lambda:PutFunctionConcurrency",
      "lambda:TagResource",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
    ]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name_prefix}-*"]
  }

  statement {
    sid       = "ManageCanaryRepairPermissionOnly"
    actions   = ["lambda:AddPermission"]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name_prefix}-publisher"]

    condition {
      test     = "StringEquals"
      variable = "lambda:Principal"
      values   = ["events.amazonaws.com"]
    }
  }

  statement {
    sid       = "CreateCanaryEventMappingOnly"
    actions   = ["lambda:CreateEventSourceMapping"]
    resources = ["*"]

    condition {
      test     = "ArnLike"
      variable = "lambda:FunctionArn"
      values   = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name_prefix}-consumer"]
    }
  }

  statement {
    sid       = "UpdateCanaryEventMappingOnly"
    actions   = ["lambda:UpdateEventSourceMapping"]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:event-source-mapping:*"]

    condition {
      test     = "ArnLike"
      variable = "lambda:FunctionArn"
      values   = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name_prefix}-consumer"]
    }
  }

  statement {
    sid = "ManageCanaryQueuesOnly"
    actions = [
      "sqs:CreateQueue",
      "sqs:SetQueueAttributes",
      "sqs:TagQueue",
    ]
    resources = ["arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.name_prefix}-*"]
  }

  statement {
    sid = "ManageCanaryParameterOnly"
    actions = [
      "ssm:AddTagsToResource",
      "ssm:PutParameter",
    ]
    resources = ["arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/mymemo/agentcore-canary/${var.environment}/*"]
  }

  statement {
    sid       = "InspectCanaryRolesOnly"
    actions   = ["iam:SimulatePrincipalPolicy"]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-*"]
  }

  dynamic "statement" {
    for_each = {
      consumer  = "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-consumer"
      control   = "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-control"
      preflight = "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-preflight"
      publisher = "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-publisher"
    }

    content {
      sid       = "Pass${title(statement.key)}RoleOnly"
      actions   = ["iam:PassRole"]
      resources = [statement.value]

      condition {
        test     = "StringEquals"
        variable = "iam:PassedToService"
        values   = ["lambda.amazonaws.com"]
      }

      condition {
        test     = "ArnEquals"
        variable = "iam:AssociatedResourceArn"
        values   = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name_prefix}-${statement.key}"]
      }
    }
  }

  statement {
    sid       = "PassRuntimeRoleOnly"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-runtime"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["bedrock-agentcore.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "iam:AssociatedResourceArn"
      values   = ["arn:aws:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:runtime/mymemo_agentcore_canary_prod-*"]
    }
  }

  statement {
    sid = "CreateTaggedCanaryNetworkAndKey"
    actions = [
      "ec2:AllocateAddress",
      "ec2:CreateNatGateway",
      "ec2:CreateRouteTable",
      "ec2:CreateSecurityGroup",
      "ec2:CreateSubnet",
      "kms:CreateKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Application"
      values   = ["mymemo-agentcore-canary"]
    }
  }

  statement {
    sid       = "TagCanaryNetworkOnCreate"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Application"
      values   = ["mymemo-agentcore-canary"]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values = [
        "AllocateAddress",
        "CreateNatGateway",
        "CreateRouteTable",
        "CreateSecurityGroup",
        "CreateSubnet",
      ]
    }
  }

  statement {
    sid = "ManageTaggedCanaryNetworkAndKey"
    actions = [
      "ec2:AssociateRouteTable",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:CreateRoute",
      "ec2:ModifySubnetAttribute",
      "ec2:ReplaceRoute",
      "kms:EnableKeyRotation",
      "kms:PutKeyPolicy",
      "kms:TagResource",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Application"
      values   = ["mymemo-agentcore-canary"]
    }
  }

  statement {
    sid     = "ManageCanaryKeyAliasOnly"
    actions = ["kms:CreateAlias"]
    resources = [
      "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:alias/${local.name_prefix}",
      "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "kms:RequestAlias"
      values   = ["alias/${local.name_prefix}"]
    }
  }

  statement {
    sid       = "InspectRequiredSecretMetadataOnly"
    actions   = ["secretsmanager:ListSecretVersionIds"]
    resources = local.exact_secret_arns
  }

  # The Environment-assumable deployment and campaign-launch roles are owned by
  # the separately approved bootstrap. This role cannot mutate either itself or
  # the second GitHub-assumable principal into direct secret-reading authority.
  statement {
    sid = "ManageCanaryRolesOnly"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRolePolicy",
      "iam:PutRolePolicy",
      "iam:TagRole",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-consumer",
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-control",
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-fault-injection",
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-preflight",
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-publisher",
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-runtime",
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-task",
    ]
  }
}

resource "aws_iam_role_policy" "deployment" {
  name   = "${local.name_prefix}-deployment"
  role   = aws_iam_role.deployment.id
  policy = data.aws_iam_policy_document.deployment.json
}

resource "aws_iam_role" "campaign_launch" {
  name               = "${local.name_prefix}-campaign-launch"
  assume_role_policy = data.aws_iam_policy_document.github_operator_trust.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name_prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.states_trust.json
}

resource "aws_iam_role" "fault_injection" {
  name               = "${local.name_prefix}-fault-injection"
  assume_role_policy = data.aws_iam_policy_document.states_trust.json
}

data "aws_iam_policy_document" "campaign_launch" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name_prefix}-control"]
  }
}

resource "aws_iam_role_policy" "campaign_launch" {
  name   = "${local.name_prefix}-campaign-launch"
  role   = aws_iam_role.campaign_launch.id
  policy = data.aws_iam_policy_document.campaign_launch.json
}

data "aws_iam_policy_document" "task" {
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.control.arn,
      aws_lambda_function.preflight.arn,
      aws_lambda_function.publisher.arn,
    ]
  }

  statement {
    actions   = ["sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.dispatch.arn, aws_sqs_queue.dead_letter.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${local.name_prefix}-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

data "aws_iam_policy_document" "fault_injection" {
  statement {
    actions = ["bedrock-agentcore:StopRuntimeSession"]
    resources = [
      aws_bedrockagentcore_agent_runtime.canary.agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.canary.agent_runtime_arn}/runtime-endpoint/DEFAULT",
    ]
  }
}

resource "aws_iam_role_policy" "fault_injection" {
  name   = "${local.name_prefix}-fault-injection"
  role   = aws_iam_role.fault_injection.id
  policy = data.aws_iam_policy_document.fault_injection.json
}
