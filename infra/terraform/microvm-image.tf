# MicroVM image build pipeline (ticket #661, spec #654). The image itself is
# registered by .github/workflows/microvm-image.yml on main pushes; Terraform
# owns the build role Lambda assumes during that build (code-artifact read +
# build logs, per the Lambda MicroVMs security guide).

locals {
  microvm_image_name = "${local.common_name}-microvm"
}

data "aws_iam_policy_document" "microvm_image_build_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "microvm_image_build" {
  name               = "${local.common_name}-microvm-image-build"
  assume_role_policy = data.aws_iam_policy_document.microvm_image_build_assume.json
}

data "aws_iam_policy_document" "microvm_image_build" {
  statement {
    sid       = "CodeArtifactRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/microvm-images/*"]
  }

  # Build logs land under /aws/lambda-microvms/<image-name> (hyphenated —
  # verified live on the #646 probe; the tutorial's /aws/lambda/microvms/...
  # spelling is kept as a fallback in case the platform changes it back).
  statement {
    sid = "BuildLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda-microvms/${local.microvm_image_name}*",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda-microvms/${local.microvm_image_name}*:*",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/microvms/${local.microvm_image_name}*",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/microvms/${local.microvm_image_name}*:*",
    ]
  }
}

resource "aws_iam_role_policy" "microvm_image_build" {
  name   = "${local.common_name}-microvm-image-build-policy"
  role   = aws_iam_role.microvm_image_build.id
  policy = data.aws_iam_policy_document.microvm_image_build.json
}
