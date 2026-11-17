variable "state_encryption_passphrase" {
  description = "Passphrase that derives the OpenTofu state-encryption key (PBKDF2 -> AES-GCM). Supply it as TF_VAR_state_encryption_passphrase; never commit it. At least 16 characters."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.state_encryption_passphrase) >= 16
    error_message = "state_encryption_passphrase must be at least 16 characters."
  }
}

variable "environment_name" {
  description = "Name of this environment. Used for the host, tunnel and generated credentials."
  type        = string
  default     = "staging"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.environment_name))
    error_message = "environment_name must be a lowercase DNS label."
  }
}

# --- Host VM ---------------------------------------------------------------

variable "server_type" {
  description = "Hetzner Cloud server type, for example cx22 (2 vCPU, 4 GB)."
  type        = string
  default     = "cx22"
}

variable "location" {
  description = "Hetzner Cloud location, for example fsn1, nbg1 or hel1."
  type        = string
  default     = "fsn1"
}

variable "image" {
  description = "Hetzner Cloud image name or id."
  type        = string
  default     = "ubuntu-24.04"
}

variable "ssh_keys" {
  description = "Names or ids of existing Hetzner Cloud SSH keys authorized on the staging host."
  type        = list(string)

  validation {
    condition     = length(var.ssh_keys) > 0
    error_message = "ssh_keys must name at least one Hetzner Cloud SSH key."
  }
}

variable "volume_size" {
  description = "Size in GiB of the volume that holds the checkout and container data."
  type        = number
  default     = 40
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to reach SSH on the staging host. No other inbound traffic is opened."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "repository_url" {
  description = "Git URL of the Scholium repository cloned onto the host."
  type        = string
  default     = "https://github.com/scholium/scholium.git"
}

variable "repository_ref" {
  description = "Branch, tag or commit deployed from repository_url."
  type        = string
  default     = "main"
}

variable "repository_ssh_private_key" {
  description = "Optional SSH private key for cloning a private repository. Stored in the encrypted state only."
  type        = string
  sensitive   = true
  default     = null
}

# --- Object store ----------------------------------------------------------

variable "object_store_provider" {
  description = "Object-store implementation to provision: \"s3\" (AWS S3) or \"r2\" (Cloudflare R2). Swapping it swaps the one active object-store module block; the S3_* application settings are identical."
  type        = string
  default     = "s3"

  validation {
    condition     = contains(["s3", "r2"], var.object_store_provider)
    error_message = "object_store_provider must be \"s3\" or \"r2\"."
  }
}

variable "object_bucket_name" {
  description = "Name of the content bucket. S3 bucket names are globally unique; override the default in real deployments."
  type        = string
  default     = "scholium-staging-content"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.object_bucket_name))
    error_message = "object_bucket_name must be 3-63 characters: lowercase letters, digits, hyphens and dots."
  }
}

variable "object_store_force_destroy" {
  description = "Allow `tofu destroy` to delete a non-empty S3 bucket. Leave false for anything holding real data."
  type        = bool
  default     = false
}

variable "s3_force_path_style" {
  description = "Use path-style S3 addressing (S3_FORCE_PATH_STYLE). False suits AWS S3 and Cloudflare R2; enable it for stores such as MinIO."
  type        = bool
  default     = false
}

variable "aws_region" {
  description = "AWS region for the object-store-s3 module when object_store_provider is \"s3\"."
  type        = string
  default     = "eu-central-1"
}

variable "r2_jurisdiction" {
  description = "Cloudflare R2 jurisdiction when object_store_provider is \"r2\": default, eu or fedramp."
  type        = string
  default     = "default"

  validation {
    condition     = contains(["default", "eu", "fedramp"], var.r2_jurisdiction)
    error_message = "r2_jurisdiction must be one of: default, eu, fedramp."
  }
}

variable "r2_location" {
  description = "Optional Cloudflare R2 placement hint: apac, eeur, enam, weur, wnam or oc. Null lets Cloudflare choose."
  type        = string
  default     = null

  validation {
    condition     = var.r2_location == null || contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], coalesce(var.r2_location, "-"))
    error_message = "r2_location must be null or one of: apac, eeur, enam, weur, wnam, oc."
  }
}

# --- Edge ------------------------------------------------------------------

variable "cloudflare_account_id" {
  description = "Cloudflare account id (32 lowercase hex characters) that owns the tunnel and, for R2, the bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32 character lowercase hex Cloudflare account id."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id (32 lowercase hex characters) holding the DNS records and rate-limit ruleset."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32 character lowercase hex Cloudflare zone id."
  }
}

variable "api_hostname" {
  description = "Public API hostname in the Cloudflare zone, for example api.staging.example.com."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.api_hostname))
    error_message = "api_hostname must be a lowercase fully qualified hostname."
  }
}

variable "api_origin" {
  description = "Where the Cloudflare Tunnel connector forwards API traffic. The compose stack publishes the API on the host's port 8000."
  type        = string
  default     = "http://127.0.0.1:8000"

  validation {
    condition     = can(regex("^https?://[^\\s/]+(/\\S*)?$", var.api_origin))
    error_message = "api_origin must be an http:// or https:// URL."
  }
}

# --- Application stack -----------------------------------------------------

variable "database_host" {
  description = "Host name of the PostgreSQL service in the compose project."
  type        = string
  default     = "db"
}

variable "database_name" {
  description = "Database name created by the compose PostgreSQL service."
  type        = string
  default     = "scholium"
}

variable "database_user" {
  description = "Database user created by the compose PostgreSQL service. Its password is generated by OpenTofu."
  type        = string
  default     = "scholium"
}

variable "committee_public_key" {
  description = "Ed25519 committee public key (32 bytes, hex or base64) used for review escrow."
  type        = string
}

variable "smtp_url" {
  description = "SMTP URL used for verification and notification email (for example smtp://user:pass@host:587)."
  type        = string
  sensitive   = true
}

variable "orcid_client_id" {
  description = "ORCID OAuth client id."
  type        = string
}

variable "orcid_client_secret" {
  description = "ORCID OAuth client secret."
  type        = string
  sensitive   = true
}

variable "ai_provider" {
  description = "Application AI provider for reviews: anthropic or ollama."
  type        = string
  default     = "anthropic"

  validation {
    condition     = contains(["anthropic", "ollama"], var.ai_provider)
    error_message = "ai_provider must be \"anthropic\" or \"ollama\"."
  }
}

variable "anthropic_api_key" {
  description = "Anthropic API key when ai_provider is \"anthropic\". Stored in the encrypted state only."
  type        = string
  sensitive   = true
  default     = null
}

variable "sandbox_backend" {
  description = "Reproducibility sandbox backend: docker, podman, remote or none."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["docker", "podman", "remote", "none"], var.sandbox_backend)
    error_message = "sandbox_backend must be one of: docker, podman, remote, none."
  }
}

variable "sandbox_url" {
  description = "Sandbox service URL when sandbox_backend is \"remote\"."
  type        = string
  default     = null
}

variable "sandbox_token" {
  description = "Bearer token for the sandbox service when sandbox_backend is \"remote\" (at least 32 characters)."
  type        = string
  sensitive   = true
  default     = null
}

variable "web_origins" {
  description = "Browser origins allowed to call the API. Defaults to the API hostname."
  type        = list(string)
  default     = []
}

variable "site_url" {
  description = "Public origin of the web app. Defaults to https://<api_hostname>."
  type        = string
  default     = null
}

variable "stack_environment" {
  description = "Extra or overriding environment variables for the compose stack (for example COMPOSE_PROFILES=sandbox). Values are stored in the encrypted state."
  type        = map(string)
  sensitive   = true
  default     = {}
}
