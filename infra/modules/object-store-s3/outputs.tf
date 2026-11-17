# Object-store contract shared with the object-store-r2 module. Each output maps
# one-to-one onto the application setting of the same name in upper case
# (s3_bucket -> S3_BUCKET, ...).

output "s3_endpoint_url" {
  description = "S3 endpoint URL, for the S3_ENDPOINT_URL setting."
  value       = "https://s3.${local.region}.amazonaws.com"
}

output "s3_region" {
  description = "Region the bucket lives in, for the S3_REGION setting."
  value       = local.region
}

output "s3_bucket" {
  description = "Bucket name, for the S3_BUCKET setting."
  value       = aws_s3_bucket.this.bucket
}

output "s3_access_key_id" {
  description = "Access key id of the scoped IAM user, for the S3_ACCESS_KEY_ID setting."
  value       = aws_iam_access_key.this.id
}

output "s3_secret_access_key" {
  description = "Secret access key of the scoped IAM user, for the S3_SECRET_ACCESS_KEY setting."
  value       = aws_iam_access_key.this.secret
  sensitive   = true
}
