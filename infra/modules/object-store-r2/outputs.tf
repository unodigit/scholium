# Object-store contract shared with the object-store-s3 module. Each output maps
# one-to-one onto the application setting of the same name in upper case
# (s3_bucket -> S3_BUCKET, ...).

output "s3_endpoint_url" {
  description = "R2 S3-compatible endpoint URL, for the S3_ENDPOINT_URL setting."
  value       = local.s3_endpoint_url
}

output "s3_region" {
  description = "Region for the S3 client, for the S3_REGION setting. R2 always uses \"auto\"."
  value       = "auto"
}

output "s3_bucket" {
  description = "Bucket name, for the S3_BUCKET setting."
  value       = cloudflare_r2_bucket.this.name
}

output "s3_access_key_id" {
  description = "Access key id (the scoped API token's id), for the S3_ACCESS_KEY_ID setting."
  value       = cloudflare_account_token.s3_access.id
}

output "s3_secret_access_key" {
  description = "Secret access key (SHA-256 of the scoped API token's value), for the S3_SECRET_ACCESS_KEY setting."
  value       = sha256(cloudflare_account_token.s3_access.value)
  sensitive   = true
}
