resource "aws_s3_bucket" "workspace" {
  bucket = "${local.common_name}-workspace"
}

resource "aws_s3_bucket_public_access_block" "workspace" {
  bucket = aws_s3_bucket.workspace.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "workspace" {
  bucket = aws_s3_bucket.workspace.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspace" {
  bucket = aws_s3_bucket.workspace.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "workspace" {
  bucket = aws_s3_bucket.workspace.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "workspace" {
  bucket = aws_s3_bucket.workspace.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "workspace_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.workspace.arn,
      "${aws_s3_bucket.workspace.arn}/*",
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

resource "aws_s3_bucket_policy" "workspace_tls_only" {
  bucket = aws_s3_bucket.workspace.id
  policy = data.aws_iam_policy_document.workspace_tls_only.json
}
