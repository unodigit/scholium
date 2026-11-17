output "server_id" {
  description = "Id of the Hetzner Cloud server."
  value       = hcloud_server.this.id
}

output "server_name" {
  description = "Name of the Hetzner Cloud server."
  value       = hcloud_server.this.name
}

output "ipv4_address" {
  description = "Public IPv4 address of the server."
  value       = hcloud_server.this.ipv4_address
}

output "ipv6_address" {
  description = "Public IPv6 address of the server."
  value       = hcloud_server.this.ipv6_address
}

output "ssh_command" {
  description = "Convenience SSH command for the server."
  value       = "ssh root@${hcloud_server.this.ipv4_address}"
}

output "volume_id" {
  description = "Id of the data volume attached to the server."
  value       = hcloud_volume.data.id
}

output "volume_name" {
  description = "Name of the data volume."
  value       = hcloud_volume.data.name
}

output "firewall_id" {
  description = "Id of the firewall that allows SSH and nothing else inbound."
  value       = hcloud_firewall.this.id
}

output "stack_service" {
  description = "systemd unit that runs the compose stack on the host."
  value       = "scholium-stack.service"
}

output "compose_project_dir" {
  description = "Directory on the host holding the checkout and the compose project."
  value       = local.app_dir
}
