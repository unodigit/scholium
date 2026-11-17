variable "name" {
  description = "Name of the Hetzner Cloud server. Also names the volume and firewall."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.name))
    error_message = "name must be a lowercase DNS label: letters, digits and hyphens, at most 63 characters."
  }
}

variable "server_type" {
  description = "Hetzner Cloud server type, for example cx22 (2 vCPU, 4 GB)."
  type        = string
  default     = "cx22"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.server_type))
    error_message = "server_type must be a Hetzner Cloud server type such as cx22."
  }
}

variable "location" {
  description = "Hetzner Cloud location, for example fsn1, nbg1 or hel1."
  type        = string
  default     = "fsn1"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.location))
    error_message = "location must be a Hetzner Cloud location such as fsn1."
  }
}

variable "image" {
  description = "Hetzner Cloud image name or id. Ubuntu 24.04 ships podman 4.9, the version this module targets."
  type        = string
  default     = "ubuntu-24.04"

  validation {
    condition     = can(regex("^[a-z0-9._-]+$", var.image))
    error_message = "image must be a Hetzner Cloud image name or id."
  }
}

variable "ssh_keys" {
  description = "Names or ids of existing Hetzner Cloud SSH keys authorized on the server. At least one is required so the host can be reached."
  type        = list(string)

  validation {
    condition     = length(var.ssh_keys) > 0
    error_message = "ssh_keys must name at least one Hetzner Cloud SSH key."
  }
}

variable "volume_name" {
  description = "Name of the volume holding the checkout and container data. Defaults to \"<name>-data\"."
  type        = string
  default     = null

  validation {
    condition     = var.volume_name == null || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", coalesce(var.volume_name, "x")))
    error_message = "volume_name must be a lowercase DNS label: letters, digits and hyphens, at most 63 characters."
  }
}

variable "volume_size" {
  description = "Volume size in GiB. Hetzner Cloud volumes are at least 10 GiB."
  type        = number
  default     = 40

  validation {
    condition     = var.volume_size >= 10 && floor(var.volume_size) == var.volume_size
    error_message = "volume_size must be a whole number of at least 10 GiB."
  }
}

variable "data_root" {
  description = "Mount point of the data volume. The repository is checked out in its app/ subdirectory."
  type        = string
  default     = "/srv/scholium"

  validation {
    condition     = can(regex("^/[A-Za-z0-9/._-]+$", var.data_root))
    error_message = "data_root must be an absolute path such as /srv/scholium."
  }
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to reach SSH (22/tcp). No other inbound traffic is opened: the API is reached through the Cloudflare Tunnel, which is outbound-only."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]

  validation {
    condition = length(var.ssh_allowed_cidrs) > 0 && alltrue([
      for cidr in var.ssh_allowed_cidrs : can(cidrhost(cidr, 0))
    ])
    error_message = "ssh_allowed_cidrs must contain at least one valid IPv4 or IPv6 CIDR."
  }
}

variable "repository_url" {
  description = "Git URL of the Scholium repository cloned onto the host. Use an SSH URL together with repository_ssh_private_key for a private repository."
  type        = string
  default     = "https://github.com/scholium/scholium.git"

  validation {
    condition     = can(regex("^(https?://|ssh://|git@).+$", var.repository_url))
    error_message = "repository_url must be an https://, ssh:// or git@ URL."
  }
}

variable "repository_ref" {
  description = "Branch, tag or commit deployed from repository_url."
  type        = string
  default     = "main"

  validation {
    condition     = length(trimspace(var.repository_ref)) > 0
    error_message = "repository_ref must not be empty."
  }
}

variable "repository_ssh_private_key" {
  description = "Optional SSH private key (OpenSSH or PEM) used to clone repository_url. It is written to /etc/scholium/git-key with mode 0600 and stored in the OpenTofu state, so keep state encryption on."
  type        = string
  sensitive   = true
  default     = null
}

variable "stack_environment" {
  description = "Environment variables for the compose stack, written to its .env (0600). Pass S3_*, DATABASE_URL and application secrets here. Values are stored in the (encrypted) OpenTofu state."
  type        = map(string)
  sensitive   = true
  default     = {}
}

variable "tunnel_token" {
  description = "Optional Cloudflare Tunnel token from the edge-cloudflare module. When set, cloud-init installs cloudflared and runs the connector under systemd."
  type        = string
  sensitive   = true
  default     = null
}

variable "labels" {
  description = "Labels applied to the server, volume and firewall."
  type        = map(string)
  default     = {}
}
