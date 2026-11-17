variable "bucket_name" {
  description = "Name of the S3 bucket to create. S3 bucket names are globally unique."
  type        = string
  default     = "scholium-content"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3-63 characters: lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit."
  }
}

variable "iam_user_name" {
  description = "Name of the IAM user that receives the scoped object-store credentials. IAM user names are unique per AWS account."
  type        = string
  default     = "scholium-s3"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.iam_user_name))
    error_message = "iam_user_name must be 1-64 characters from A-Z a-z 0-9 + = , . @ _ -."
  }
}

variable "force_destroy" {
  description = "Allow `tofu destroy` to delete the bucket even when it still holds objects. Leave false for anything holding real data."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to the bucket and the IAM user."
  type        = map(string)
  default     = {}
}
