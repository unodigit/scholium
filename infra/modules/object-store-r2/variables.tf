variable "account_id" {
  description = "Cloudflare account id (32 hex characters) that owns the bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32 character lowercase hex Cloudflare account id."
  }
}

variable "bucket_name" {
  description = "Name of the R2 bucket to create."
  type        = string
  default     = "scholium-content"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3-63 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit."
  }
}

variable "jurisdiction" {
  description = "Data jurisdiction of the bucket: default, eu or fedramp. It cannot be changed after creation and selects the S3 endpoint host."
  type        = string
  default     = "default"

  validation {
    condition     = contains(["default", "eu", "fedramp"], var.jurisdiction)
    error_message = "jurisdiction must be one of: default, eu, fedramp."
  }
}

variable "location" {
  description = "Optional location hint for the bucket: apac, eeur, enam, weur, wnam or oc. Null lets Cloudflare choose automatically."
  type        = string
  default     = null

  validation {
    condition     = var.location == null || contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], coalesce(var.location, "-"))
    error_message = "location must be null or one of: apac, eeur, enam, weur, wnam, oc."
  }
}

variable "storage_class" {
  description = "Default storage class for new objects: Standard or InfrequentAccess."
  type        = string
  default     = "Standard"

  validation {
    condition     = contains(["Standard", "InfrequentAccess"], var.storage_class)
    error_message = "storage_class must be Standard or InfrequentAccess."
  }
}

variable "token_name" {
  description = "Name of the scoped API token that backs the S3 credentials. Defaults to \"<bucket_name>-s3-access\"."
  type        = string
  default     = null
}
