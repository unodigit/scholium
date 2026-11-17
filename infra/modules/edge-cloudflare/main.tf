# Cloudflare edge for the Scholium API.
#
#   * a Cloudflare Tunnel that carries traffic from the edge to the API origin,
#     so the origin needs no public address or open inbound port;
#   * a proxied DNS CNAME that points the API hostname at that tunnel, plus any
#     extra DNS records the caller asks for (web hostname, mail records, ...);
#   * a WAF rate-limit ruleset that throttles clients per source IP.
#
# This module does not configure the Cloudflare provider: the caller does. The
# credential it uses needs: Account > Cloudflare Tunnel > Edit,
# Zone > DNS > Edit and Zone > Zone WAF > Edit.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.20.0"
    }
  }
}

# The tunnel is remotely managed ("cloudflare" config source): its ingress rules
# live in Cloudflare (below) and the connector only needs the token output by
# this module, so no config file or credentials file has to be shipped.
resource "cloudflare_zero_trust_tunnel_cloudflared" "api" {
  account_id = var.account_id
  name       = var.tunnel_name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "api" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.api.id

  config = {
    ingress = [
      {
        hostname = var.api_hostname
        service  = var.api_origin
      },
      # The last rule must be a catch-all; anything else is not ours to serve.
      {
        service = "http_status:404"
      },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "api" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.api.id
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.zone_id
  name    = var.api_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.api.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # 1 means "automatic", the only value allowed for proxied records
  comment = "Cloudflare Tunnel to the Scholium API origin (managed by OpenTofu)"
}

resource "cloudflare_dns_record" "extra" {
  for_each = var.dns_records

  zone_id  = var.zone_id
  name     = each.key
  type     = each.value.type
  content  = each.value.content
  proxied  = each.value.proxied
  ttl      = each.value.proxied ? 1 : each.value.ttl
  priority = each.value.priority
  comment  = coalesce(each.value.comment, "Managed by OpenTofu")
}

# One rate-limit rule for the API hostname. A zone has a single ruleset for the
# http_ratelimit phase, so this module owns that phase for the zone.
resource "cloudflare_ruleset" "rate_limit" {
  zone_id     = var.zone_id
  name        = "${var.tunnel_name}-rate-limit"
  description = "Per-client rate limit for the Scholium API (managed by OpenTofu)"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      action      = "block"
      description = "Rate limit ${var.api_hostname} by client"
      enabled     = true
      expression  = "(http.host eq \"${var.api_hostname}\")"

      action_parameters = {
        response = {
          status_code  = 429
          content_type = "application/json"
          content      = jsonencode({ detail = "Too many requests" })
        }
      }

      ratelimit = {
        characteristics     = var.rate_limit_characteristics
        period              = var.rate_limit_period
        requests_per_period = var.rate_limit_requests
        mitigation_timeout  = var.rate_limit_mitigation_timeout
      }
    },
  ]
}
