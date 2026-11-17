# Staging state and state encryption.
#
# The state lives in an S3-compatible bucket (AWS S3, Cloudflare R2, Hetzner
# Object Storage, MinIO, ...). OpenTofu cannot read input variables from a
# backend block, so everything provider-specific is supplied at init time:
#
#   export TF_VAR_state_encryption_passphrase='...'   # at least 16 characters
#   tofu init \
#     -backend-config="bucket=scholium-tofu-state" \
#     -backend-config="key=scholium/staging/terraform.tfstate" \
#     -backend-config="region=auto" \
#     -backend-config="endpoints={s3=\"https://<account>.r2.cloudflarestorage.com\"}" \
#     -backend-config="skip_credentials_validation=true" \
#     -backend-config="skip_region_validation=true" \
#     -backend-config="skip_requesting_account_id=true"
#
# `tofu init -backend=false` (used by npm run infra:check) skips the backend
# entirely, so checking the configuration needs no bucket and no credentials.
#
# The encryption block below encrypts both the state and saved plan files
# client-side with AES-GCM, deriving the key from a passphrase with PBKDF2.
# `enforced = true` makes OpenTofu refuse to read or write unencrypted state.
# The passphrase itself is never stored in this repository.

terraform {
  backend "s3" {
    key = "scholium/staging/terraform.tfstate"

    # The bucket, region, endpoint and credentials are supplied at init time
    # (see above). S3-compatible services such as Cloudflare R2, Hetzner
    # Object Storage or MinIO are not AWS, so the AWS-specific validation the
    # S3 backend would otherwise do is disabled here.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_encryption_passphrase
    }

    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }

    state {
      method   = method.aes_gcm.state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}
