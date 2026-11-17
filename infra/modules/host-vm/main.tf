# Hetzner Cloud host for a Scholium deployment.
#
# Creates one server and one volume attached to it. The server's cloud-init
# installs podman, mounts the volume, checks the repository out onto it and
# runs the repository's compose.yaml under systemd, so the host runs exactly
# the compose stack used for local development.
#
# This module does not configure the hcloud provider: the caller does. The
# provider reads its token from HCLOUD_TOKEN and needs access to servers,
# volumes, firewalls and SSH keys in the project.

terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.70.2"
    }
  }
}

locals {
  volume_name = coalesce(var.volume_name, "${var.name}-data")
  app_dir     = "${var.data_root}/app"

  # One KEY=value line per compose/application setting. Written to
  # /etc/scholium/stack.env (0600) and copied to the compose project's .env.
  # Sorted so a change to one value produces a one-line diff.
  stack_env = join("\n", [
    for key in sort(keys(var.stack_environment)) :
    "${key}=${var.stack_environment[key]}"
  ])

  # The deploy script uses the key only when the file has content.
  git_key = coalesce(var.repository_ssh_private_key, "")

  cloud_init = templatefile("${path.module}/cloud-init.yaml", {
    app_dir          = local.app_dir
    data_root        = var.data_root
    environment_name = var.name
    git_key          = local.git_key
    repository_ref   = var.repository_ref
    repository_url   = var.repository_url
    stack_env        = local.stack_env
    tunnel_token     = coalesce(var.tunnel_token, "")
  })
}

# The API is reached through the Cloudflare Tunnel, which is an outbound
# connection, so the only inbound port this host needs is SSH. A firewall with
# no outbound rules allows all outbound traffic.
resource "hcloud_firewall" "this" {
  name   = "${var.name}-ssh"
  labels = var.labels

  dynamic "rule" {
    for_each = var.ssh_allowed_cidrs
    content {
      description = "SSH from ${rule.value}"
      direction   = "in"
      protocol    = "tcp"
      port        = "22"
      source_ips  = [rule.value]
    }
  }
}

# hcloud accepts cloud-init user_data only when the server is created, so
# changing a stack_environment value or the tunnel token replaces the server.
# The data volume is a separate resource: it keeps its contents and is
# reattached to the replacement server.
resource "hcloud_server" "this" {
  name         = var.name
  image        = var.image
  server_type  = var.server_type
  location     = var.location
  ssh_keys     = var.ssh_keys
  firewall_ids = [hcloud_firewall.this.id]
  labels       = var.labels

  user_data = local.cloud_init
}

# automount is off: cloud-init formats the volume and mounts it at data_root,
# where the checkout and the compose volumes live. The volume is attached to
# the server as soon as it exists; cloud-init waits for the device.
resource "hcloud_volume" "data" {
  name      = local.volume_name
  size      = var.volume_size
  server_id = hcloud_server.this.id
  automount = false
  labels    = var.labels
}
