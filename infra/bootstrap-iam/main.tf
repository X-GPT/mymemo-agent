locals {
  github_oidc_provider_arn = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
  github_ref_sub           = "repo:${var.github_owner}/${var.github_repository}:ref:${var.github_deploy_ref}"
}

data "aws_iam_openid_connect_provider" "github" {
  arn = local.github_oidc_provider_arn
}

data "aws_iam_policy_document" "github_actions_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

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
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_ref_sub]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = var.deploy_role_name
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume_role.json
}

data "aws_iam_policy_document" "github_actions_deploy" {
  statement {
    sid = "TerraformStateAccess"
    actions = [
      "s3:DeleteObject",
      "s3:GetBucketVersioning",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      "arn:aws:s3:::${var.terraform_state_bucket}",
      "arn:aws:s3:::${var.terraform_state_bucket}/mymemo-agent/*",
      "arn:aws:s3:::${var.terraform_state_bucket}/mymemo/staging.tfstate",
    ]
  }

  statement {
    sid = "ArtifactBucketManagement"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:DeleteBucketPolicy",
      "s3:GetAccelerateConfiguration",
      "s3:GetBucket*",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetObjectLockConfiguration",
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
    resources = ["arn:aws:s3:::${var.artifact_bucket_name}"]
  }

  statement {
    sid = "EcrRepositoryManagement"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:CreateRepository",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetAuthorizationToken",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:ListTagsForResource",
      "ecr:PutImage",
      "ecr:PutImageScanningConfiguration",
      "ecr:PutImageTagMutability",
      "ecr:TagResource",
      "ecr:UploadLayerPart",
    ]
    resources = ["*"]
  }

  statement {
    sid = "AgentInfrastructureManagement"
    actions = [
      "application-autoscaling:*",
      "cloudwatch:*",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:CreateInstanceConnectEndpoint",
      "ec2:CreateSecurityGroup",
      "ec2:CreateTags",
      "ec2:DeleteInstanceConnectEndpoint",
      "ec2:DeleteSecurityGroup",
      "ec2:DeleteTags",
      "ec2:Describe*",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifyInstanceConnectEndpoint",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:RunInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:TerminateInstances",
      "ecs:*",
      "elasticache:*",
      "elasticloadbalancing:*",
      "logs:*",
      "rds:*",
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:GetSecretValue",
      "secretsmanager:ListSecretVersionIds",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
      "secretsmanager:UpdateSecret",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "AgentEc2InstanceConnectServiceLinkedRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::*:role/aws-service-role/ec2-instance-connect.amazonaws.com/AWSServiceRoleForEC2InstanceConnect"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["ec2-instance-connect.amazonaws.com"]
    }
  }

  statement {
    sid = "AgentKmsUsage"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "rds.${var.aws_region}.amazonaws.com",
        "secretsmanager.${var.aws_region}.amazonaws.com",
      ]
    }
  }

  statement {
    sid = "AgentKmsGrantManagement"
    actions = [
      "kms:CreateGrant",
      "kms:ListGrants",
      "kms:RevokeGrant",
    ]
    resources = ["*"]

    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "rds.${var.aws_region}.amazonaws.com",
        "secretsmanager.${var.aws_region}.amazonaws.com",
      ]
    }
  }

  statement {
    sid = "AgentIamManagement"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:CreateRole",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:GetOpenIDConnectProvider",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListPolicyVersions",
      "iam:ListRolePolicies",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/mymemo-agent-*",
      "arn:aws:iam::${var.aws_account_id}:policy/mymemo-agent-*",
      local.github_oidc_provider_arn,
    ]
  }

  statement {
    sid       = "CreateServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "${var.deploy_role_name}-policy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}
