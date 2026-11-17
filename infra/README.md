# Scholium infrastructure (OpenTofu)

OpenTofu modules that describe the provider-specific pieces of a Scholium node.
The application itself contains no cloud-provider code: it speaks the S3 API
through `S3_*` settings and sits behind whatever proxy you give it. Everything
provider-specific lives here, behind one small contract per concern.

| Module | Provider | Creates |
| --- | --- | --- |
| `modules/object-store-s3` | AWS | Private S3 bucket + an IAM user that can only read, write, delete and list that bucket |
| `modules/object-store-r2` | Cloudflare | R2 bucket + an account API token that can only read and write objects in that bucket |
| `modules/edge-cloudflare` | Cloudflare | Proxied DNS record(s), a Cloudflare Tunnel to the API origin, and a WAF rate-limit ruleset |

## The object-store contract

`object-store-s3` and `object-store-r2` are interchangeable. Both expose exactly
these outputs, one per application setting:

| Output | Application setting | Sensitive |
| --- | --- | --- |
| `s3_endpoint_url` | `S3_ENDPOINT_URL` | no |
| `s3_region` | `S3_REGION` | no |
| `s3_bucket` | `S3_BUCKET` | no |
| `s3_access_key_id` | `S3_ACCESS_KEY_ID` | no |
| `s3_secret_access_key` | `S3_SECRET_ACCESS_KEY` | **yes** |

Switching provider means swapping the module block; the app-side settings keep
the same names and only their values change. Set `STORAGE_BACKEND=s3` to make
the app use them.

```sh
tofu output -raw s3_endpoint_url
tofu output -raw s3_secret_access_key   # sensitive outputs are hidden unless asked for by name
```

Provider specifics behind the contract:

- **S3**: `s3_region` is read back from the AWS provider you pass in, so it can
  never disagree with where the bucket was created. The endpoint is the
  regional `https://s3.<region>.amazonaws.com`. A bucket policy denies plain
  HTTP, public access is blocked, and incomplete multipart uploads are
  aborted after 7 days.
- **R2**: R2 has no separate S3-credential resource. Its S3 API accepts a
  Cloudflare API token as: access key id = the token's id, secret access key =
  the SHA-256 hex digest of the token's value. The module creates a token
  scoped to the one bucket (item read + item write) and derives both values.
  `s3_region` is always `auto`. `jurisdiction` (`default`, `eu`, `fedramp`)
  selects the endpoint host and cannot be changed after creation; `location`
  is an optional placement hint (`apac`, `eeur`, `enam`, `weur`, `wnam`, `oc`).

## The edge module

`edge-cloudflare` puts Cloudflare in front of the API without exposing the
origin:

- a remotely managed **Cloudflare Tunnel** whose ingress routes `api_hostname`
  to `api_origin` (anything else gets a 404);
- a proxied **DNS CNAME** from `api_hostname` to the tunnel, plus any records
  passed in `dns_records` (for example the web hostname);
- a **WAF rate-limit ruleset** that blocks a client exceeding
  `rate_limit_requests` per `rate_limit_period` on the API hostname, answering
  `429` with a JSON body. Defaults (100 requests / 10 s, 10 s block, grouped by
  client IP per data centre) are accepted on every Cloudflare plan; longer
  windows need a paid plan. A zone has a single `http_ratelimit` ruleset, so
  this module owns that phase for the zone.

To bring the tunnel up, run the connector next to the API with the token the
module outputs:

```sh
cloudflared tunnel run --token "$(tofu output -raw tunnel_token)"
```

Requests then reach the API from the connector, not from the client. Set the
API's `FORWARDED_ALLOW_IPS` to the connector's address so proxy headers are
honoured.

## Using the modules

The modules do **not** configure providers; the calling configuration does, so
a module can be used with `providers = { ... }` aliases and several times over.
The root configuration must pin the same provider versions the modules pin.

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.70.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.20.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1" # the bucket is created here; credentials come from the AWS environment/profile
}

provider "cloudflare" {} # credential comes from CLOUDFLARE_API_TOKEN

module "object_store" {
  source = "./modules/object-store-s3"

  bucket_name = "example-scholium-content" # S3 bucket names are globally unique
}

# ...or Cloudflare R2 instead (drop the aws provider and module):
# module "object_store" {
#   source = "./modules/object-store-r2"
#
#   account_id  = var.cloudflare_account_id
#   bucket_name = "example-scholium-content"
# }

module "edge" {
  source = "./modules/edge-cloudflare"

  account_id   = var.cloudflare_account_id
  zone_id      = var.cloudflare_zone_id
  api_hostname = "api.example.com"
  api_origin   = "http://api:8000"
}
```

Credentials are never passed as module variables and no secret value is
committed anywhere in this directory; supply them through the environment.

| Module | Credential needs |
| --- | --- |
| `object-store-s3` | AWS credentials allowed to create S3 buckets and IAM users, access keys and policies |
| `object-store-r2` | `CLOUDFLARE_API_TOKEN` with Account API Tokens Write and Workers R2 Storage Write |
| `edge-cloudflare` | `CLOUDFLARE_API_TOKEN` with Cloudflare Tunnel Edit (account), DNS Edit and Zone WAF Edit (zone) |

**State holds secrets.** The IAM secret access key, the R2 API token value and
the tunnel token are all stored in the OpenTofu state. Use an encrypted remote
backend with restricted access for anything beyond a throwaway environment, and
never commit state files.

## Provider pins

Every provider is pinned to an exact version in the `required_providers` block
of each module (no `~>` or `>=` ranges), so a plan today and a plan next month
resolve to the same provider. Bump a pin deliberately, in all modules that use
the provider, and re-run the checks below.

| Provider | Version | Used by |
| --- | --- | --- |
| `hashicorp/aws` | `6.70.0` | `object-store-s3` |
| `cloudflare/cloudflare` | `5.20.0` | `object-store-r2`, `edge-cloudflare` |

## Checking the modules

None of this needs cloud credentials; `init` only downloads providers.

```sh
tofu fmt -check -recursive infra

cd infra/modules/<module>
tofu init -backend=false
tofu validate
```

`init` creates a `.terraform/` directory in the module; do not commit it.

If `init` succeeds but `validate` or `plan` fails with *Failed to read any
lines from plugin's stdout*, the provider plugin could not open its Unix
socket: sockets are limited to about 108 characters and OpenTofu puts them under
`$TMPDIR`. This happens when `$TMPDIR` points somewhere with a long path (for
example deep inside a workspace). Run with a short `TMPDIR`, for example
`TMPDIR=. tofu validate`.
