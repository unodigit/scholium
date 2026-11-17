output "tunnel_id" {
  description = "Id of the Cloudflare Tunnel."
  value       = cloudflare_zero_trust_tunnel_cloudflared.api.id
}

output "tunnel_token" {
  description = "Token the cloudflared connector runs with (cloudflared tunnel run --token ...). Treat as a secret."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.api.token
  sensitive   = true
}

output "tunnel_cname" {
  description = "Target of the API CNAME record, <tunnel id>.cfargotunnel.com."
  value       = "${cloudflare_zero_trust_tunnel_cloudflared.api.id}.cfargotunnel.com"
}

output "api_hostname" {
  description = "Public hostname of the API."
  value       = var.api_hostname
}

output "api_url" {
  description = "Public URL of the API through the edge."
  value       = "https://${var.api_hostname}"
}

output "dns_record_ids" {
  description = "Ids of the DNS records this module created, keyed by record name."
  value = merge(
    { (var.api_hostname) = cloudflare_dns_record.api.id },
    { for name, record in cloudflare_dns_record.extra : name => record.id },
  )
}

output "rate_limit_ruleset_id" {
  description = "Id of the WAF rate-limit ruleset."
  value       = cloudflare_ruleset.rate_limit.id
}
