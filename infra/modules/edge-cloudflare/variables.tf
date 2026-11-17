variable "account_id" {
  description = "Cloudflare account id (32 hex characters) that owns the tunnel."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32 character lowercase hex Cloudflare account id."
  }
}

variable "zone_id" {
  description = "Id (32 hex characters) of the Cloudflare zone that holds the DNS records and the rate-limit ruleset."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.zone_id))
    error_message = "zone_id must be a 32 character lowercase hex Cloudflare zone id."
  }
}

variable "api_hostname" {
  description = "Public hostname of the API, inside the zone (for example api.example.com)."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.api_hostname))
    error_message = "api_hostname must be a lowercase fully qualified hostname such as api.example.com."
  }
}

variable "api_origin" {
  description = "URL the tunnel connector forwards API traffic to, as seen from the connector (for example http://api:8000)."
  type        = string

  validation {
    condition     = can(regex("^https?://[^\\s/]+(/\\S*)?$", var.api_origin))
    error_message = "api_origin must be an http:// or https:// URL, such as http://localhost:8000."
  }
}

variable "tunnel_name" {
  description = "Name of the Cloudflare Tunnel. Also prefixes the rate-limit ruleset name."
  type        = string
  default     = "scholium-api"
}

variable "dns_records" {
  description = "Additional DNS records to create in the zone, keyed by record name (for example the web hostname). The API record is always created."
  type = map(object({
    type     = string
    content  = string
    proxied  = optional(bool, false)
    ttl      = optional(number, 300)
    priority = optional(number)
    comment  = optional(string)
  }))
  default = {}
}

variable "rate_limit_requests" {
  description = "Requests a client may send per rate_limit_period before being blocked."
  type        = number
  default     = 100

  validation {
    condition     = var.rate_limit_requests >= 1 && floor(var.rate_limit_requests) == var.rate_limit_requests
    error_message = "rate_limit_requests must be a whole number of at least 1."
  }
}

variable "rate_limit_period" {
  description = "Rate-limit counting window in seconds. 10 is accepted on every Cloudflare plan; longer windows need a paid plan."
  type        = number
  default     = 10

  validation {
    condition     = contains([10, 60, 120, 300, 600, 3600], var.rate_limit_period)
    error_message = "rate_limit_period must be one of: 10, 60, 120, 300, 600, 3600 (seconds)."
  }
}

variable "rate_limit_mitigation_timeout" {
  description = "Seconds a client stays blocked after exceeding the limit. 10 is accepted on every Cloudflare plan; longer blocks need a paid plan."
  type        = number
  default     = 10

  validation {
    condition     = var.rate_limit_mitigation_timeout >= 0
    error_message = "rate_limit_mitigation_timeout must not be negative."
  }
}

variable "rate_limit_characteristics" {
  description = "How requests are grouped when counting. The default (per client IP within a data centre) is the only grouping the Free plan allows."
  type        = list(string)
  default     = ["cf.colo.id", "ip.src"]

  validation {
    condition     = length(var.rate_limit_characteristics) > 0
    error_message = "rate_limit_characteristics must not be empty."
  }
}
