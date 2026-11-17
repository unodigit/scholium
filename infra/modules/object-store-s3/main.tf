# AWS S3 object store for Scholium.
#
# Creates a private bucket and an IAM user whose only permissions are object
# read/write/delete and listing on that bucket. The outputs (outputs.tf) are the
# shared object-store contract, named after the application's S3_* settings.
#
# This module does not configure the AWS provider: the caller does, and the
# bucket is created in whichever region that provider targets. The region
# reported in the `s3_region` output is read back from the provider so it can
# never disagree with where the bucket actually lives.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.70.0"
    }
  }
}

data "aws_region" "current" {}

locals {
  region = data.aws_region.current.region
}

resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy

  tags = var.tags
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Interrupted multipart uploads (large uploads that never completed) otherwise
# keep accruing storage charges invisibly.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
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

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json

  # Changing the public access block and the bucket policy at the same time
  # can fail with a ConflictingOperation error.
  depends_on = [aws_s3_bucket_public_access_block.this]
}

resource "aws_iam_user" "this" {
  name = var.iam_user_name
  tags = var.tags
}

resource "aws_iam_access_key" "this" {
  user = aws_iam_user.this.name
}

data "aws_iam_policy_document" "access" {
  statement {
    sid    = "ListBucket"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:ListBucketMultipartUploads",
    ]

    resources = [aws_s3_bucket.this.arn]
  }

  statement {
    sid    = "ReadWriteObjects"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]

    resources = ["${aws_s3_bucket.this.arn}/*"]
  }
}

resource "aws_iam_user_policy" "this" {
  name   = "${var.iam_user_name}-object-store"
  user   = aws_iam_user.this.name
  policy = data.aws_iam_policy_document.access.json
}
