# Cloudflare R2 object store for Scholium.
#
# Creates an R2 bucket and an account API token that can read and write objects
# in that one bucket and nothing else. The outputs (outputs.tf) are the shared
# object-store contract, named after the application's S3_* settings, and are
# the same five values the object-store-s3 module produces.
#
# R2 has no separate "S3 credential" resource. Its S3-compatible API accepts a
# Cloudflare API token as follows:
#   Access Key ID     = the token's id
#   Secret Access Key = the SHA-256 hex digest of the token's value
# Both are derived below.
#
# This module does not configure the Cloudflare provider: the caller does. The
# credential it uses must be allowed to create R2 buckets and account API
# tokens ("Account API Tokens Write" plus "Workers R2 Storage Write").

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.20.0"
    }
  }
}

locals {
  token_name = coalesce(var.token_name, "${var.bucket_name}-s3-access")

  # R2's S3 API host differs per jurisdiction: <account>.r2..., <account>.eu.r2...
  jurisdiction_label = var.jurisdiction == "default" ? "" : "${var.jurisdiction}."
  s3_endpoint_url    = "https://${var.account_id}.${local.jurisdiction_label}r2.cloudflarestorage.com"

  # How an API token policy names a single bucket.
  bucket_resource = "com.cloudflare.edge.r2.bucket.${var.account_id}_${var.jurisdiction}_${var.bucket_name}"

  # Permission group ids are account specific lookups; resolve them by name
  # rather than hard-coding ids. A name Cloudflare renames fails the plan loudly.
  permission_group_ids = {
    for g in concat(
      data.cloudflare_account_api_token_permission_groups_list.item_read.result,
      data.cloudflare_account_api_token_permission_groups_list.item_write.result,
    ) : g.name => g.id
  }
}

resource "cloudflare_r2_bucket" "this" {
  account_id    = var.account_id
  name          = var.bucket_name
  location      = var.location
  jurisdiction  = var.jurisdiction
  storage_class = var.storage_class
}

data "cloudflare_account_api_token_permission_groups_list" "item_read" {
  account_id = var.account_id
  name       = "Workers R2 Storage Bucket Item Read"
}

data "cloudflare_account_api_token_permission_groups_list" "item_write" {
  account_id = var.account_id
  name       = "Workers R2 Storage Bucket Item Write"
}

resource "cloudflare_account_token" "s3_access" {
  account_id = var.account_id
  name       = local.token_name

  policies = [
    {
      effect = "allow"
      permission_groups = [
        { id = local.permission_group_ids["Workers R2 Storage Bucket Item Read"] },
        { id = local.permission_group_ids["Workers R2 Storage Bucket Item Write"] },
      ]
      resources = jsonencode({
        (local.bucket_resource) = "*"
      })
    }
  ]

  # The token may only be created once the bucket exists, so a failed bucket
  # create never leaves an orphaned credential behind.
  depends_on = [cloudflare_r2_bucket.this]
}
