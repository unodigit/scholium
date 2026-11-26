# Running and deploying Scholium

| | |
| --- | --- |
| Document | Operations guide |
| Audience | Anyone who runs a Scholium node: on a laptop, in a local container stack, or on a cloud host |
| Companion docs | `tech_architect.md` (sections 14 and 15 describe the backend interfaces and the `deploy/` and `infra/` directories), `../infra/README.md` (the OpenTofu modules in detail), `../.env.example` (every setting with a placeholder value) |

Scholium runs the same code everywhere. What changes between a laptop and a cloud host is four **backends**, each chosen by environment variables:

| Backend | Choices | Selected by |
| --- | --- | --- |
| Database | PostgreSQL 16, or a SQLite file (the default, **deprecated**: tests and local development only) | `DATABASE_URL` |
| Object storage | an S3-API bucket, or a directory on disk (the default, for tests and local development) | `STORAGE_BACKEND` |
| Background jobs | inline (default), an in-process thread, or a separate worker process | `JOBS_MODE` |
| Code sandbox | docker (default), podman, a remote sandbox service, or off | `SANDBOX_BACKEND` |

The defaults need nothing installed beyond Python and Node, and they are what `npm test` uses. Everything that needs a container engine or a cloud account is opt-in and lives outside `npm test`: see [section 9](#9-opt-in-commands-outside-npm-test).

**Supported backends, and what is deprecated.** PostgreSQL 16 and S3-API object storage (AWS S3, Cloudflare R2, MinIO and the like) are the supported backends. **SQLite is deprecated**: use it for tests and local development only. Deprecated means a warning and a production refusal, not removal. SQLite behaves exactly as before, and `npm test` still runs on it with no container, network or credential. Two things follow from the deprecation:

- A process that opens a SQLite database logs one `WARNING` (once per process): `SQLite is deprecated; use PostgreSQL and move existing data with python -m app.migrate_backend (see docs/deploy.md). SQLite remains only for tests and local development`.
- A production start (`SCHOLIUM_ENV=production`) on SQLite, or on `STORAGE_BACKEND=fs`, stops with `Unsafe production configuration: DATABASE_URL must be a PostgreSQL URL in production (SQLite is deprecated); STORAGE_BACKEND must be s3 in production; …`. The first problem names `DATABASE_URL`, the second `STORAGE_BACKEND`; the message goes on to list every other problem too ([section 2.11](#211-what-production-refuses-to-start-without)).

To move an existing SQLite and `fs` node to PostgreSQL and S3, see [section 7](#7-moving-an-existing-node-with-appmigrate_backend). To develop on your machine against PostgreSQL and S3, see [section 3.2](#32-against-postgresql-and-s3-with-npm-run-stackdeps).

## Contents

1. [Three ways to run](#1-three-ways-to-run)
2. [Environment variables](#2-environment-variables)
3. [Running on the host](#3-running-on-the-host)
4. [The local podman stack](#4-the-local-podman-stack)
5. [The PostgreSQL test lane](#5-the-postgresql-test-lane)
6. [The worker and sandbox processes](#6-the-worker-and-sandbox-processes)
7. [Moving an existing node with `app.migrate_backend`](#7-moving-an-existing-node-with-appmigrate_backend)
8. [Staging with OpenTofu](#8-staging-with-opentofu)
9. [Opt-in commands outside `npm test`](#9-opt-in-commands-outside-npm-test)
10. [Troubleshooting](#10-troubleshooting)

## 1. Three ways to run

| | Host (development) | Local stack | Staging |
| --- | --- | --- | --- |
| How it starts | `uv run python -m app` (add `npm run stack:deps` for PostgreSQL, MinIO and Mailpit) | `npm run stack:up` | `tofu apply` in `infra/envs/staging` |
| Where | your machine, no containers (or with the dependencies in containers) | podman or docker on your machine | one Hetzner Cloud VM running the same compose file under systemd |
| Database | SQLite file (`./scholium.db`, deprecated), or the stack's PostgreSQL ([section 3.2](#32-against-postgresql-and-s3-with-npm-run-stackdeps)) | PostgreSQL 16 + pgvector container | PostgreSQL container on the VM |
| Objects | files under `CONTENT_DIR`, or the stack's MinIO | MinIO container (`STORAGE_BACKEND=s3`) | AWS S3 or Cloudflare R2 (`STORAGE_BACKEND=s3`) |
| Jobs | eager (inline) | separate `worker` container (`JOBS_MODE=external`) | separate `worker` container |
| Sandbox | docker (default); `not_run` if there is no engine | off (`SANDBOX_BACKEND=none`) | off by default |
| Mail | none (`SMTP_URL` empty), or the stack's Mailpit | Mailpit, inbox on `:8025` | your SMTP server |
| Environment | `SCHOLIUM_ENV=dev` | `dev` | `production` (insecure defaults are refused, SQLite and `fs` among them) |
| Public access | `127.0.0.1` | `127.0.0.1` only | API through a Cloudflare Tunnel |

The stack is the cloud deployment in miniature: only `S3_ENDPOINT_URL`, the credentials and a few secrets differ between the local stack and staging.

## 2. Environment variables

### 2.1 How they are read

- The API, the worker and the sandbox service read **their process environment** when they start. Restart after changing a value. None of them loads a `.env` file.
- `compose.yaml` and `scripts/stack-smoke.sh` read **`.env` next to `compose.yaml`**, then the environment. To run something on the host with the values from a file: `set -a; . ./.env; set +a`.
- `.env.example` is the template. It lists every variable with a placeholder. Copy it to `.env` (`.env` is git-ignored) and never commit real secrets.
- With `SCHOLIUM_ENV=production` the API refuses to start unless the settings are safe ([section 2.11](#211-what-production-refuses-to-start-without)). Independently of the environment, an unknown `JOBS_MODE`, `STORAGE_BACKEND`, `AI_PROVIDER` or `SCHOLIUM_ENV` is refused rather than guessed at.
- `S3_FORCE_PATH_STYLE` is a *flag*: `1`/`0` or `true`/`false`, `yes`/`no`, `on`/`off`. The other on/off settings (`ORCID_MOCK`, `ARXIV_MOCK`, `JOBS_EAGER`, `RATE_LIMIT_ENABLED`) take digits only, and an unparsable number silently keeps its default.

The "Default" column is the default of the application on the host. Where the container image or `compose.yaml` chooses differently, the description says so.

### 2.2 Database backend

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./scholium.db` (SQLite is **deprecated**) | SQLAlchemy URL. Production requires PostgreSQL: `postgresql://…`, `postgres://…` or `postgresql+psycopg://…`. SQLite, including an unset `DATABASE_URL`, and every other scheme are refused there ([section 2.11](#211-what-production-refuses-to-start-without)). `postgresql://…` and `postgres://…` are rewritten to the psycopg 3 driver (`postgresql+psycopg://…`). The API image sets no `DATABASE_URL`: compose builds a PostgreSQL URL from the `POSTGRES_*` variables below, and anything else that runs the image must supply one. |
| `DB_POOL_SIZE` | `5` | PostgreSQL connection pool size per process. Ignored for SQLite. |
| `DB_MAX_OVERFLOW` | `10` | Extra PostgreSQL connections allowed above the pool size under load. Ignored for SQLite. |

PostgreSQL connections are checked with a ping before use (`pool_pre_ping`) and run in UTC. Tables are created at startup (`create_all`); on PostgreSQL that runs under an advisory lock, so replicas started together do not race.

With a SQLite URL the process logs the one-line deprecation warning quoted at the top of this guide, once per process, and otherwise behaves as it always has. To get off SQLite, see [section 7](#7-moving-an-existing-node-with-appmigrate_backend).

**Local stack only** (read by `compose.yaml`, not by the application):

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_USER` | `scholium` | Database role the `db` service creates. |
| `POSTGRES_PASSWORD` | `scholium-local-only` | Its password. It is put into a URL unescaped, so use only letters, digits and `-_.`. Change it for anything another machine can reach. |
| `POSTGRES_DB` | `scholium` | Database name. |
| `POSTGRES_IMAGE` | `docker.io/pgvector/pgvector:pg16` | PostgreSQL 16 with the `vector` extension. |
| `DB_PORT` | `5433` | Host port, bound to `127.0.0.1`. |

### 2.3 Object storage backend

Content blobs (named by their CID) and in-flight tus uploads go through one `ObjectStore` interface. Selecting the backend changes where the bytes live and nothing else: every blob is still verified against its CID on write and on read.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORAGE_BACKEND` | `fs` | `s3` keeps objects in an S3-API bucket and is required in production. `fs` keeps them under `CONTENT_DIR`, for tests and local development; production refuses it. Anything else is refused at startup. |
| `CONTENT_DIR` | `./data/content` | Root of the `fs` backend (image: `/data/content`). The layout is one file per CID, unchanged from before the backend existed, so an existing directory is read as it stands. |
| `S3_BUCKET` | *(none)* | Bucket name. Required when `STORAGE_BACKEND=s3`. |
| `S3_ENDPOINT_URL` | *(empty)* | S3 endpoint. Empty uses the client's default (AWS). Set it for MinIO, Cloudflare R2 and other S3-compatible services. |
| `S3_REGION` | *(empty)* | Region. R2 uses `auto`; some self-hosted servers ignore it. |
| `S3_ACCESS_KEY_ID` | *(empty)* | Access key. Both keys must be set together. Outside production, leaving both empty falls back to the S3 client's own credential lookup. |
| `S3_SECRET_ACCESS_KEY` | *(empty)* | **Secret.** Never logged or printed. |
| `S3_FORCE_PATH_STYLE` | `0` | *Flag.* `1` addresses the bucket as `endpoint/bucket`, which MinIO and most self-hosted servers need; `0` for AWS S3 and R2. Compose defaults it to `1`. |

The application imports `boto3` only as an S3 API client, and only when `STORAGE_BACKEND=s3`. It contains no AWS, Cloudflare or Hetzner code; everything provider-specific is in `infra/`.

**Local stack only:**

| Variable | Default | Meaning |
| --- | --- | --- |
| `MINIO_ROOT_USER` | `scholium-minio` | MinIO administrator. The bucket is created with it, and the api and worker use it too unless `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set. |
| `MINIO_ROOT_PASSWORD` | `scholium-minio-secret` | Its password (at least 8 characters). |
| `MINIO_IMAGE` | `docker.io/pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | Any image that contains `minio`, `mc` and `curl`. |
| `MINIO_PORT`, `MINIO_CONSOLE_PORT` | `9000`, `9001` | Host ports for the S3 API and the console. |

In the stack, `STORAGE_BACKEND` is always `s3` for the api, worker and sandbox, whatever `.env` says. To point the stack at another S3-API service, set `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (and `S3_BUCKET`, `S3_REGION`, `S3_FORCE_PATH_STYLE`).

### 2.4 Jobs backend

| Variable | Default | Meaning |
| --- | --- | --- |
| `JOBS_MODE` | *(unset: follows `JOBS_EAGER`)* | `eager` runs a job inline on the caller (tests and the default). `thread` runs it on a daemon thread inside the API process. `external` only writes the queued row; a separate `python -m app.worker` runs it. |
| `JOBS_EAGER` | `1` | Legacy switch, used only while `JOBS_MODE` is unset: `1` means `eager`, `0` means `thread`. |

Production refuses `eager`. The stack and staging run `JOBS_MODE=external` and `JOBS_EAGER=0` on the api and the worker. See [section 6.1](#61-the-worker).

### 2.5 Sandbox backend

The reproducibility agent runs an author's code bundle in a container with no network, a read-only root filesystem, one CPU, 2 GB of memory and a 10-minute limit. `SANDBOX_BACKEND` chooses who starts that container.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_BACKEND` | `docker` | `docker` or `podman` start the container on this node through that CLI. `remote` posts the bundle's CID to a sandbox service. `none` never runs code: every run is reported `not_run`. Compose defaults the api to `none`. |
| `SANDBOX_URL` | *(empty)* | Base URL of the sandbox service. Required for `remote`. Compose default: `http://sandbox:8001`. |
| `SANDBOX_TOKEN` | *(empty)* | **Secret.** Bearer token shared by the api and the service; at least 32 characters when `remote` (`openssl rand -hex 32`). |
| `REPRO_DOCKER_IMAGE` | `python:3.12-slim` | Image the bundle runs in. It must already be present locally: a run never pulls an image. |

Read by `python -m app.sandbox_service` itself (the service is a separate process, see [section 6.2](#62-the-sandbox-service)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_TOKEN` | *(required)* | The same shared token; the service refuses to start with fewer than 32 characters. |
| `SANDBOX_BACKEND` | `docker` | For the service this is the engine it uses: `docker` or `podman`. `remote` and `none` are refused. |
| `REPRO_DOCKER_IMAGE` | `python:3.12-slim` | As above. |
| `SANDBOX_CONCURRENCY` | `2` | Runs executing at once; each may use a CPU and 2 GB. |
| `SANDBOX_QUEUE_LIMIT` | `8` | Runs allowed to wait for a slot; past that `POST /runs` answers `503`. |
| `HOST`, `PORT` | `127.0.0.1`, `8001` | Where it listens. A container sets `HOST=0.0.0.0`. |
| `STORAGE_BACKEND`, `CONTENT_DIR`, `S3_*` | `fs`, `./data/content` | Where bundles are read from: `fs` reads `CONTENT_DIR`, `s3` reads the bucket the `S3_*` variables name (the one the api writes to), see [section 6.2](#62-the-sandbox-service). |

**Local stack only:** `COMPOSE_PROFILES=sandbox` starts the `sandbox` service. `SANDBOX_RUNNER` (default `podman`) is the engine the service itself uses; compose passes it as the service's `SANDBOX_BACKEND`, so it does not collide with the api's `SANDBOX_BACKEND=remote`.

### 2.6 Node identity and secrets

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_KEY_PATH` | `./data/node.key` | File holding the node's Ed25519 signing key (image: `/data/node.key`). Create one with `python -m app.modules.admin init-node`. |
| `NODE_KEY` | *(empty)* | The same key as a value: 32 or 64 bytes, hex or base64. When set it wins over `NODE_KEY_PATH`: the process writes it to an owner-only (0600) file in a private runtime directory and points `NODE_KEY_PATH` there. **Secret.** |
| `JWT_SECRET` | `change-me-in-production` | Signs access tokens. Production needs a random value of at least 32 characters. |
| `REVIEW_UNIQUENESS_KEY` | derived from `JWT_SECRET` in development | Key of the HMAC behind "one review per person". Production needs its own random value of at least 32 characters. **Keep it stable**: with a different key an earlier review no longer matches the same person's new one. |
| `COMMITTEE_PUBLIC_KEY` | *(empty)* | The committee's public key for review escrow: 32 bytes, hex or base64. Required in production. |
| `NODE_DID` | *(derived from the node key)* | Overrides the node's DID in `origin_node`. `ORIGIN_NODE` and `SCHOLIUM_NODE_DID` are accepted as aliases. |
| `NODE_OPERATOR` | `NextGenius` | Operator name shown on the network summary. `SCHOLIUM_NODE_OPERATOR` is an alias. |

A node without a signing key still works but signs nothing of its own (renditions, AI pre-reviews, ORCID credentials, arXiv imports, the sync head). In production the key is mandatory.

### 2.7 Mail, ORCID, arXiv, Crossref and AI

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_URL` | *(empty)* | Where verification and notification mail goes, for example `smtp://user:pass@host:587`. Required in production. Compose defaults it to `smtp://mailpit:1025`. |
| `ORCID_BASE_URL` | `https://orcid.org` | ORCID OAuth endpoint (use `https://sandbox.orcid.org` to test). |
| `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET` | *(empty)* | ORCID OAuth client. Required in production. |
| `ORCID_MOCK` | `1` | `1` answers ORCID sign-in locally. Production requires `0`. |
| `ARXIV_MOCK` | `1` | `1` answers arXiv imports locally. Production requires `0`. |
| `ARXIV_API_URL` | `https://export.arxiv.org/api/query` | Override the arXiv endpoint. |
| `CROSSREF_ENABLED` | *(off)* | Set to exactly `1` to resolve DOIs through Crossref. |
| `AI_PROVIDER` | `fake` | `fake`, `anthropic`, `openai` or `ollama` (any case). Anything else is refused at startup, in every environment. Production refuses `fake`. The ids name protocols, not vendors: see [Choosing an AI provider](#choosing-an-ai-provider) below. |
| `AI_HOSTED_MODEL` | `claude-sonnet-5-5` | Model id the hosted providers (`anthropic` and `openai`) send. The default is an Anthropic model id, which another server rejects: set it for anything else (production requires it for `openai`), with the id taken from the provider's documentation. |
| `ANTHROPIC_API_KEY` | *(empty)* | **Secret.** Key for `AI_PROVIDER=anthropic`, whichever server `ANTHROPIC_BASE_URL` names. Required in production when `AI_PROVIDER=anthropic`. |
| `ANTHROPIC_BASE_URL` | *(empty: the Anthropic SDK's default)* | Where `AI_PROVIDER=anthropic` sends requests, for a server that speaks the Anthropic protocol. The SDK appends `/v1/messages`. |
| `OPENAI_API_KEY` | *(empty)* | **Secret.** Bearer key for `AI_PROVIDER=openai`. Required in production when `AI_PROVIDER=openai`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL of a server that speaks the OpenAI chat-completions protocol, for `AI_PROVIDER=openai`. Requests go to this URL plus `/chat/completions`, so include any `/v1` the server needs. A trailing slash is ignored; empty means the default. |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server for `AI_PROVIDER=ollama`. Setting it in the environment also selects Ollama embeddings for semantic search; unset, a built-in hashing embedder is used. |
| `OLLAMA_MODEL` | `llama3.1` | Chat model for `AI_PROVIDER=ollama`. |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model, used when `OLLAMA_URL` is set. |

#### Choosing an AI provider

`AI_PROVIDER` chooses who answers the chat requests of the AI pre-review:

| `AI_PROVIDER` | Protocol | Runs | Settings |
| --- | --- | --- | --- |
| `fake` | none: deterministic text, no network | in the process | none. Tests and development; production refuses it. |
| `anthropic` | Anthropic Messages | hosted | `ANTHROPIC_API_KEY`, `AI_HOSTED_MODEL`, and `ANTHROPIC_BASE_URL` for any server but Anthropic's. |
| `openai` | OpenAI-compatible chat completions (`POST …/chat/completions`) | hosted | `OPENAI_API_KEY`, `AI_HOSTED_MODEL`, and `OPENAI_BASE_URL` for any server but OpenAI's. |
| `ollama` | Ollama | self-hosted | `OLLAMA_URL`, `OLLAMA_MODEL`. |

The ids name wire protocols, not vendors. `openai` is a plain HTTP client for the chat-completions format (no OpenAI SDK), so it works with any server that speaks it; `anthropic` with `ANTHROPIC_BASE_URL` works with any server that speaks the Anthropic protocol. There is no setting named after a vendor. DeepSeek serves both protocols, so it shows both (placeholders; no real key or model id belongs in a file you commit):

```sh
# DeepSeek, OpenAI protocol
AI_PROVIDER=openai
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=<your DeepSeek API key>
AI_HOSTED_MODEL=<model id from DeepSeek's documentation>

# DeepSeek, Anthropic protocol
AI_PROVIDER=anthropic
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_API_KEY=<your DeepSeek API key>
AI_HOSTED_MODEL=<model id from DeepSeek's documentation>
```

The model id is left out on purpose: model ids change, so copy the one you want from the provider's own documentation, which also gives the two endpoint roots (DeepSeek's differ, as above). `.env.example` has the same lines, commented out. `compose.yaml` passes all of these variables to the api and worker, so in the stack they go in `.env`.

- **Hosted providers see listed papers only.** `anthropic` and `openai` send paper text to a third party, so an unlisted draft is refused with `PrivateDraftError` before any request is made. Private drafts need `ollama` (or `fake`).
- **Keys stay out of every output.** They are never logged, never part of an error message and never stored in a review record. A failure names the provider and the HTTP status only, for example `openai provider: HTTP 401 from POST https://…/chat/completions`.
- **Retries (`openai`).** A 429, a 5xx answer, a timeout or another transport failure is retried twice more (three requests in all) after an exponential wait that starts at one second, or after the server's `Retry-After` when that is a whole number of seconds (at most 30). Any other error fails at once, as does an answer with no content or one cut off at the token limit (`finish_reason` `length`). A `reasoning_content` field, when a server sends one, is ignored.
- **Chat completions only.** Semantic-search embeddings are unaffected: `OLLAMA_URL` still selects Ollama embeddings, and the built-in hashing embedder stays the default.
- **Production.** `openai` needs `OPENAI_API_KEY` and an explicit `AI_HOSTED_MODEL`; `anthropic` needs `ANTHROPIC_API_KEY`. Production cannot tell an Anthropic model id from another server's, so when you set `ANTHROPIC_BASE_URL`, set `AI_HOSTED_MODEL` too.
- **Check against the real endpoint.** `npm run test:llm-live` sends one request through each protocol ([section 9.1](#91-the-live-llm-check)).

### 2.8 HTTP, web and process

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCHOLIUM_ENV` | `dev` | `dev`, or `production` (alias `prod`). Production validates the settings at startup ([section 2.11](#211-what-production-refuses-to-start-without)). The web app reads it too. |
| `WEB_ORIGINS` | `http://localhost:3000` | Comma-separated browser origins allowed to call the API (CORS). Production: explicit `https` origins, none on localhost. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Public URL of the API. The web image **bakes it in at build time** (and into its Content-Security-Policy); change it and the web image must be rebuilt. Production: not a loopback address. |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Public origin of the web app, used in share and OG-image URLs. Also a build-time value. Production: not a loopback address. |
| `RATE_LIMIT_ENABLED` | `1` | Per-tier write throttling. Production requires `1`. |
| `HOST` | `0.0.0.0` | Address `python -m app` listens on (every interface; set `127.0.0.1` to keep it to this machine). |
| `PORT` | `8000` | Port `python -m app` listens on. |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Peers whose `X-Forwarded-*` headers `python -m app` honours. Set it to the proxy's or tunnel connector's address when TLS ends in front of the api. |

**Local stack only:** `API_PORT` (8000), `WEB_PORT` (3000), `MAILPIT_SMTP_PORT` (1025) and `MAILPIT_UI_PORT` (8025) are host ports, all bound to `127.0.0.1`. After changing `API_PORT` or `WEB_PORT`, also set `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL` and `WEB_ORIGINS` to match and run `npm run stack:up` again. `SCHOLIUM_API_IMAGE`, `SCHOLIUM_WEB_IMAGE`, `MAILPIT_IMAGE` and `CLAMAV_IMAGE` rename or re-tag the images.

### 2.9 Application tuning

None of these is tied to a backend; all have safe defaults. The `UPLOAD_*` variables are read on every call, so a change applies without a restart. A value that is missing, not a number or not positive is ignored in favour of the default, so a typo cannot switch a protection off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UPLOAD_TTL_SECONDS` | `86400` (24 h) | How long an upload may stay incomplete before the periodic job deletes it. |
| `UPLOAD_ORPHAN_TTL_SECONDS` | `604800` (7 days) | How long a completed upload may go without a record its owner signed naming its bytes before the periodic job deletes it (and its bytes, unless some record still names them). `UPLOAD_ORPHAN_TTL` is accepted as an alias. |
| `UPLOAD_QUOTA_BYTES` | 10 GiB (twice the 5 GiB upload limit) | Most bytes one DID may have in flight across incomplete uploads. |
| `UPLOAD_DAILY_QUOTA_BYTES` | 2 GiB | What an account younger than 90 days may hold in flight plus finish in a rolling day. If set explicitly it applies to every account unless the next variable is also set. |
| `UPLOAD_DAILY_QUOTA_BYTES_ESTABLISHED` | 20 GiB | The same allowance for accounts 90 days or older. |
| `REFRESH_REUSE_GRACE_SECONDS` | `30` | How long after a refresh token was rotated the same value is still accepted and receives its successor (concurrent tabs refreshing together). |
| `REFRESH_COOKIE_SAMESITE` | `lax` | `SameSite` attribute of the refresh cookie (`lax`, `strict` or `none`). |
| `CLAMD_SOCKET` | *(unset)*; `clamav:3310` in the local stack | Where the ClamAV daemon (clamd) is: the path of a Unix socket, or `host:port`. `compose.yaml` sets it to its `clamav` service. Unset, bundle scans report that the antivirus is unavailable: that is not a failed scan, so a version with a code or data bundle waits for its safety scan (it is not held) and is re-scanned every 15 minutes. Set it on any node where authors upload bundles. |
| `MODERATION_POLICIES_YAML` | the bundled file | Path of the moderation policies file. `POLICIES_YAML` is an alias. |
| `OAI_ADMIN_EMAIL` | `admin@scholium.local` | Contact address OAI-PMH reports to harvesters. |

**ClamAV in the local stack.** The `clamav` service runs the official ClamAV image (`CLAMAV_IMAGE`, default `docker.io/clamav/clamav:1.4`): clamd, which the api and the worker reach at `clamav:3310` on the compose network, and freshclam, which keeps the signature database on the `clamav-db` volume up to date. Nothing is published on the host: clamd has no authentication, so keep it on the compose network. clamd holds the signatures in memory, about 1.2 GB. The first start downloads them, which takes minutes, so bundle scans wait until clamd is up and are retried every 15 minutes; the api and the worker do not wait for it to start. `deploy/compose/clamd.conf` sets `StreamMaxLength`, `MaxScanSize` and `MaxFileSize` to 4000M, clamd's maximum: a bundle above that is held as too large for the malware scan. A node that does not use the stack runs its own clamd and sets `CLAMD_SOCKET` to it.

### 2.10 Test and migration variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TEST_DATABASE_URL` | `npm run test:pg`, `apps/api/conftest.py`, CI | A PostgreSQL server to run the API test suite against ([section 5](#5-the-postgresql-test-lane)). Unset, tests use throwaway SQLite files. |
| `SCHOLIUM_TEST_PG_PORT`, `SCHOLIUM_TEST_RUN_TOKEN` | `scripts/test-pg.sh` | Set by the script for one run: the loopback port of the throwaway database and the token in its per-worker database names. Not for you to set. |
| `COMPOSE` | `scripts/test-pg.sh` | Compose command to use, for example `COMPOSE="docker compose"`. |
| `PYTHON` | `scripts/test-pg.sh` | Interpreter used to pick a free port. |
| `STACK_COMPOSE` | every `stack:*` script | Compose command to use. Note the different name from `COMPOSE`. |
| `STACK_SMOKE_TIMEOUT` | `scripts/stack-smoke.sh` | Seconds each readiness wait may take (default 180). |
| `STACK_UP_TIMEOUT`, `STACK_UP_POLL_INTERVAL` | `npm run stack:up`, `npm run stack:deps` | Seconds each stage waits for a service before it gives up (default 300), and seconds between two status checks (default 2, may be fractional). See [section 4.4](#44-npm-scripts). |
| `LLM_LIVE_BASE_URL`, `LLM_LIVE_API_KEY`, `LLM_LIVE_MODEL`, `LLM_LIVE_OPENAI_BASE_URL` | `npm run test:llm-live` | Endpoint, key and model of the opt-in live LLM check; the last is optional. Without the first three the check is skipped ([section 9.1](#91-the-live-llm-check)). |
| `MIGRATE_FROM_S3_ACCESS_KEY_ID`, `MIGRATE_FROM_S3_SECRET_ACCESS_KEY`, `MIGRATE_FROM_S3_FORCE_PATH_STYLE` | `app.migrate_backend` | S3 credentials and addressing for the *source* side. Fall back to the `S3_*` variables when unset. |
| `MIGRATE_TO_S3_ACCESS_KEY_ID`, `MIGRATE_TO_S3_SECRET_ACCESS_KEY`, `MIGRATE_TO_S3_FORCE_PATH_STYLE` | `app.migrate_backend` | The same for the *target* side. |
| `HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`, `AWS_*`, `TF_VAR_*` | OpenTofu in `infra/envs/staging` | Provider credentials and secret inputs ([section 8](#8-staging-with-opentofu)). |

### 2.11 What production refuses to start without

With `SCHOLIUM_ENV=production`, `create_app()` raises `Unsafe production configuration: …` and the process exits, listing every problem at once, unless every item of this production checklist holds:

- `DATABASE_URL` is a PostgreSQL URL: `postgresql://…`, `postgres://…` or `postgresql+psycopg://…`. SQLite is refused, and so is leaving `DATABASE_URL` unset, because unset means SQLite (`DATABASE_URL must be a PostgreSQL URL in production (SQLite is deprecated)`);
- `STORAGE_BACKEND=s3`, and `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set. `fs` is refused (`STORAGE_BACKEND must be s3 in production`);
- `JWT_SECRET` and `REVIEW_UNIQUENESS_KEY` are random values of at least 32 characters (and the review key is not the development-derived one);
- `COMMITTEE_PUBLIC_KEY` is 32 bytes of hex or base64;
- `SMTP_URL` is set;
- the node key is usable: `NODE_KEY` holds a valid Ed25519 key, or `NODE_KEY_PATH` names an existing file that does;
- `ORCID_CLIENT_ID` and `ORCID_CLIENT_SECRET` are set, and `ORCID_MOCK=0` and `ARXIV_MOCK=0`;
- jobs are not eager (`JOBS_MODE` is `thread` or `external`);
- `SANDBOX_BACKEND` is one of `docker`, `podman`, `remote`, `none`, and for `remote` both `SANDBOX_URL` and a 32-character `SANDBOX_TOKEN` are set;
- `AI_PROVIDER` is not `fake`, and the provider is configured: `ANTHROPIC_API_KEY` for `anthropic`; `OPENAI_API_KEY` and an explicitly set `AI_HOSTED_MODEL` for `openai` (its default is an Anthropic model id, see [Choosing an AI provider](#choosing-an-ai-provider));
- `RATE_LIMIT_ENABLED=1`;
- `WEB_ORIGINS` lists explicit `https` origins, none of them localhost, and `NEXT_PUBLIC_API_URL` is not a loopback address.

A node that is still on SQLite and files, started in production unchanged, therefore stops at once with `Unsafe production configuration: DATABASE_URL must be a PostgreSQL URL in production (SQLite is deprecated); STORAGE_BACKEND must be s3 in production; …` and then the remaining problems. Move it first: [section 7](#7-moving-an-existing-node-with-appmigrate_backend). The local stack and the staging environment already satisfy both checks: compose builds a PostgreSQL URL and always runs `STORAGE_BACKEND=s3`, and the staging configuration sets a `postgresql+psycopg://…` URL and `STORAGE_BACKEND=s3` itself.

The worker and the sandbox service do not run this validation; they fail on their own missing settings (for example the service's short token).

## 3. Running on the host

### 3.1 With nothing installed: SQLite and files

No containers, no account, no configuration: SQLite, files under `./data/content`, eager jobs. This is the setup of `npm test` and of quick local development. SQLite is deprecated, so the API logs the deprecation warning once at startup ([top of this guide](#running-and-deploying-scholium)), and a production start refuses this setup. For development against the backends production uses, see [section 3.2](#32-against-postgresql-and-s3-with-npm-run-stackdeps).

```sh
npm install                                   # once, at the repository root
cd apps/api
uv run --all-packages python -m app           # API on port 8000, every interface (http://127.0.0.1:8000 here)
npm run dev --workspace apps/web              # web app on http://localhost:3000 (second terminal, repository root)
```

`uv run --all-packages` installs the workspace packages (`record-core`, `cli`) the API imports. `HOST`, `PORT` and `FORWARDED_ALLOW_IPS` ([section 2.8](#28-http-web-and-process)) change where the API listens and which proxies it trusts.

Optional first steps for a node you want to keep:

```sh
uv run --all-packages python -m app.modules.admin init-node   # create the node signing key at NODE_KEY_PATH
```

Liveness is `GET /healthz` (always 200 while the process serves). Readiness is `GET /readyz` ([section 6.1](#61-the-worker)).

To run the API and a separate worker on the host, give both the same database and put the API in external mode:

```sh
JOBS_MODE=external uv run --all-packages python -m app           # terminal 1
JOBS_MODE=external uv run --all-packages python -m app.worker    # terminal 2
```

The tests need none of this: `npm test` runs the API suite (SQLite, `STORAGE_BACKEND=fs`, eager jobs) and then the web suite, with no containers, network or credentials.

### 3.2 Against PostgreSQL and S3 with `npm run stack:deps`

To run the API on the host against the backends production uses, start only the stack's backing services. `npm run stack:deps` runs the first two stages of `npm run stack:up` ([section 4.4](#44-npm-scripts)) and returns when they are done:

```sh
npm run stack:deps     # db, minio, mailpit and the minio-init bucket job; not api, worker or web
```

It starts `db` (PostgreSQL 16 with pgvector), `minio` and `mailpit` and waits until each is healthy, then runs `minio-init` and waits until it has exited with status 0, which means the bucket `scholium` exists. The prerequisites are those of the stack ([section 4.1](#41-prerequisites)).

Then start the API in a shell with these values. They are what `compose.yaml` publishes on `127.0.0.1` when no `.env` changes the ports or credentials:

```sh
export DATABASE_URL=postgresql+psycopg://scholium:scholium-local-only@127.0.0.1:5433/scholium
export STORAGE_BACKEND=s3
export S3_ENDPOINT_URL=http://127.0.0.1:9000
export S3_BUCKET=scholium
export S3_REGION=us-east-1
export S3_FORCE_PATH_STYLE=1
export S3_ACCESS_KEY_ID=scholium-minio              # the MinIO user, MINIO_ROOT_USER
export S3_SECRET_ACCESS_KEY=scholium-minio-secret   # its password, MINIO_ROOT_PASSWORD
export SMTP_URL=smtp://127.0.0.1:1025
cd apps/api
uv run --all-packages python -m app                 # API on port 8000, every interface (http://127.0.0.1:8000 here)
```

| Value | Where it comes from |
| --- | --- |
| `127.0.0.1:5433`, user `scholium`, password `scholium-local-only`, database `scholium` | `DB_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` ([section 2.2](#22-database-backend)) |
| `http://127.0.0.1:9000` | `MINIO_PORT` ([section 2.3](#23-object-storage-backend)) |
| `scholium-minio` and `scholium-minio-secret` as the S3 keys | `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`: MinIO's administrator, which is also what the stack's api uses |
| bucket `scholium`, region `us-east-1`, `S3_FORCE_PATH_STYLE=1` | the defaults of `S3_BUCKET`, `S3_REGION` and `S3_FORCE_PATH_STYLE` in `compose.yaml`. MinIO needs path-style addressing. |
| `smtp://127.0.0.1:1025` | `MAILPIT_SMTP_PORT`. The inbox is at http://localhost:8025. |

If your `.env` changes any of these (a different port, other credentials), use your values: the table lists the defaults. The API reads its process environment, not `.env` ([section 2.1](#21-how-they-are-read)).

- **Environment and jobs stay development.** `SCHOLIUM_ENV` is `dev` and jobs are eager, so no worker is needed. To run a separate worker as in [section 3.1](#31-with-nothing-installed-sqlite-and-files), give both processes these same variables and `JOBS_MODE=external`.
- **The data is the stack's.** It lives in the stack's volumes (`db-data`, `minio-data`), so it survives `npm run stack:down` and a later `npm run stack:up` finds it. `npm run stack:down` stops these services too.
- **Do this after, not before, moving a node in.** The first host start creates the tables and a bookkeeping row, and `app.migrate_backend` refuses a target that holds any row ([section 7.1](#71-before-you-start)). To move an existing node into this database, run the migration before you start the API against it.
- **Tests are unchanged.** `npm test` stays on SQLite; to run the API suite against PostgreSQL use `npm run test:pg` ([section 5](#5-the-postgresql-test-lane)).

## 4. The local podman stack

`compose.yaml` at the repository root starts the cloud shape of Scholium on your machine.

### 4.1 Prerequisites

- **podman 4.9 or newer with `podman-compose` 1.6.0 or newer**, rootless is fine; or **docker with the compose plugin**. The scripts use `podman-compose` when it is installed and `docker compose` otherwise. `STACK_COMPOSE="docker compose" npm run stack:up` picks one explicitly.
- **Why 1.6.0.** `compose.yaml` uses nested variable defaults (`${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER:-scholium-minio}}`) and `COMPOSE_PROFILES`, which podman-compose only understands from 1.6.0. Every `stack:*` script goes through `scripts/stack-compose.sh`, which reads `podman-compose --version` and refuses an older one with exit status 1, naming the version it found. Upgrade with `pipx install podman-compose`, or use docker compose (`STACK_COMPOSE="docker compose"`), whose version is not checked.
- Node and npm (the scripts are npm scripts), and `curl` for `stack:smoke`.
- Network access for the first build: it pulls `python:3.12-slim`, `node:22-alpine`, PostgreSQL, MinIO, Mailpit and ClamAV images, and the `clamav` service then downloads the virus signatures (a few hundred MB), and installs the dependencies inside the build.
- Free host ports 3000, 8000, 5433, 9000, 9001, 1025 and 8025 (all configurable, [section 2](#2-environment-variables)).

### 4.2 First start

```sh
cp .env.example .env     # optional: every value has the same default inside compose.yaml
npm run stack:up         # build the images and start everything in the background, in stages
npm run stack:smoke      # wait for readiness and check the whole path end to end
```

`stack:up` starts the services in three stages and waits between them ([section 4.4](#44-npm-scripts)); the first run also builds the images, which takes several minutes. Without a `.env` the stack starts with local-only placeholder credentials. Use different values for anything another machine can reach.

The first start has no node signing key. The stack works without one but signs nothing of its own; make one on the volume the api and worker share, then restart them:

```sh
podman-compose exec api python -m app.modules.admin init-node
podman-compose restart api worker
```

(`docker compose` in place of `podman-compose` if that is what you use.) Alternatively set `NODE_KEY` in `.env`.

### 4.3 Services

| Service | What it is | On the host |
| --- | --- | --- |
| `web` | Next.js app | http://localhost:3000 |
| `api` | FastAPI with `JOBS_MODE=external` and `STORAGE_BACKEND=s3` | http://localhost:8000 (`/healthz`, `/readyz`) |
| `worker` | the api image running `python -m app.worker` | none |
| `db` | PostgreSQL 16 with pgvector | `127.0.0.1:5433` |
| `minio` | S3-compatible object store | http://localhost:9000 (API), http://localhost:9001 (console) |
| `minio-init` | one-shot job that creates the bucket, then exits | none |
| `mailpit` | SMTP sink with a web inbox | http://localhost:8025 (inbox), `127.0.0.1:1025` (SMTP) |
| `clamav` | ClamAV daemon that scans bundles for malware (`clamav:3310`, [section 2.9](#29-application-tuning)) | none: not published |
| `sandbox` | reproducibility runner, opt-in (`COMPOSE_PROFILES=sandbox`) | not published |

The api and worker are the same image started with different commands, and share the database, the bucket and a `/data` volume (the node key). Every published port is bound to `127.0.0.1`; put a proxy or tunnel in front to reach the stack from elsewhere. Containers run as unprivileged users (uid 10001 in the api image, `node` in the web image).

Named volumes `db-data`, `minio-data`, `mailpit-data`, `clamav-db`, `app-data` and `sandbox-work` hold the state.

### 4.4 npm scripts

| Script | What it does |
| --- | --- |
| `npm run stack:up` | Build the images and start the stack detached, **in three stages** (below). |
| `npm run stack:deps` | The first two stages only: `db`, `minio`, `mailpit` and the `minio-init` bucket job, with no api, worker, web or clamav (the host API then has no `CLAMD_SOCKET`, so bundle scans wait). For running the API on the host ([section 3.2](#32-against-postgresql-and-s3-with-npm-run-stackdeps)) and for moving a node into the stack's database ([section 7.5](#75-example-a-host-install-into-the-local-stack)). |
| `npm run stack:down` | `down --remove-orphans`: stop and remove the containers. **The volumes stay.** Extra arguments are appended: `npm run stack:down -- --volumes` also deletes them. |
| `npm run stack:logs` | Follow the logs, 100 lines back. One service: `npm run stack:logs -- api`. |
| `npm run stack:reset` | `down --volumes`, then a plain `up -d --build --remove-orphans` in one step, not in stages: deletes the database, the bucket, the inbox, the ClamAV signatures and the node key, and starts from scratch. On podman 4.9 prefer `npm run stack:down -- --volumes` followed by `npm run stack:up` (see the next subsection). |
| `npm run stack:smoke` | Verify the running stack (below). Exit status 0 only if every step passed. |

All of them honour `COMPOSE_PROFILES` and `STACK_COMPOSE`. They are not part of `npm test`.

**Why `stack:up` starts services in stages.** `compose.yaml` orders its services with `depends_on`: the api and the worker wait for `db` to be healthy and for the one-shot `minio-init` to complete. podman-compose 1.6 turns every `depends_on` entry into a `--requires` of the container it creates, and podman 4.9 cannot start a service whose `depends_on` names a service that has already exited. By the time the api and worker are due, `minio-init` has done its job and exited, so a single `up -d` can leave them unstarted on podman 4.9 (`generating dependency graph … not found in input list`). `npm run stack:up` (`scripts/stack-up-staged.sh`) therefore never relies on `depends_on`: every stage passes `--no-deps`, and the script itself waits for what the next stage needs.

| Stage | Command (through `scripts/stack-compose.sh`) | The script then waits until |
| --- | --- | --- |
| 1 | `up -d --no-deps db minio mailpit` | each of the three reports `(healthy)` |
| 2 | `up -d --no-deps minio-init` | `minio-init` has exited with status 0: the bucket exists |
| 3 | `up -d --no-deps --build --remove-orphans clamav api worker web`, plus `sandbox` when `COMPOSE_PROFILES` enables it | nothing: it returns once they are started. `clamav` is listed first so it starts before the api and the worker, but they do not wait for it (a scan before clamd is ready is retried). `npm run stack:smoke` waits for readiness. |

`npm run stack:deps` stops after stage 2. Each wait gives up after `STACK_UP_TIMEOUT` seconds (default 300), naming the service and the last status it saw; `STACK_UP_POLL_INTERVAL` (default 2) is the time between two status checks. A `minio-init` that exits with a non-zero status fails the run at once, because it does not run again; read its output with `npm run stack:logs -- minio-init`. A compose command that fails ends the script with that command's exit status. `depends_on` stays in `compose.yaml` for plain `docker compose up` and for anyone who runs the file directly.

`stack:smoke` runs three steps in order and stops at the first failure, naming it:

1. **readyz**: wait until `GET /readyz` on the api returns 200 (database and object store both answer);
2. **web**: wait until `GET /` on the web app returns 200;
3. **api smoke**: run `python -m app.smoke` inside the api container. It writes a random blob through the S3 store, reads it back, compares and deletes it; then it enqueues a `system.ping` job and waits for the **separate worker container** to mark it done. The smoke process refuses to run unless `JOBS_MODE=external`, so a pass proves the worker works.

Steps 1 and 2 retry for up to `STACK_SMOKE_TIMEOUT` seconds (default 180) each. Extra arguments go to `python -m app.smoke`: `npm run stack:smoke -- --job-timeout 120`.

### 4.5 Building the images by hand

```sh
podman build -f deploy/containers/api.Containerfile -t scholium-api .
podman build -f deploy/containers/web.Containerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.org -t scholium-web .
```

`docker build` takes the same arguments. Build from the repository root. The api image serves `python -m app` by default; the worker and the sandbox service are the same image with a different command (`python -m app.worker`, `python -m app.sandbox_service`).

### 4.6 The sandbox profile

`COMPOSE_PROFILES=sandbox npm run stack:up` adds the `sandbox` service, and `SANDBOX_BACKEND=remote` with `SANDBOX_URL=http://sandbox:8001` and a `SANDBOX_TOKEN` (at least 32 characters) points the api at it. The service reads bundles from the same bucket the api writes to, so the two meet without sharing a disk. **It does not run code yet**, though ([section 6.2](#62-the-sandbox-service)): the api image carries no docker or podman CLI for the service to start containers with, so every run is reported `not_run` (the paper's AI pre-review says so). Leave `SANDBOX_BACKEND=none` in the stack unless you have given the service an engine.

### 4.7 Changing and resetting

- After changing `.env`, run `npm run stack:up` again (it recreates what changed).
- Changing `NEXT_PUBLIC_API_URL` or `NEXT_PUBLIC_SITE_URL` needs a rebuild of the web image, which `stack:up` does.
- Starting over: `npm run stack:reset`. It does not use the staged start ([section 4.4](#44-npm-scripts)), so on podman 4.9 start over with `npm run stack:down -- --volumes` and then `npm run stack:up`.

## 5. The PostgreSQL test lane

`npm test` runs the API suite on SQLite. `npm run test:pg` runs **the same suite** against PostgreSQL 16 with pgvector, so a dialect difference (raw SQL, boolean literals, time zones, case-sensitive `LIKE`, ordering ties, integer ranges, transaction isolation) cannot hide behind SQLite. Both must pass.

```sh
npm run test:pg                  # start a throwaway database, run the whole suite, remove it
npm run test:pg -- -k ledger     # extra arguments go to pytest
```

What the script (`scripts/test-pg.sh`) does:

1. picks a free loopback port and a unique compose project name, so two runs on one machine never share a container;
2. starts `deploy/compose/compose.test.yaml` (a single `db` service, data on tmpfs, role `scholium`/`scholium`, database `scholium_test`) with `podman-compose`, or `docker compose` if that is all you have (`COMPOSE="docker compose"` forces one);
3. waits until the container's health check passes;
4. runs `uv run --all-packages pytest` with `TEST_DATABASE_URL` pointing at it;
5. removes the container on exit, also when the tests fail or you press Ctrl-C.

`apps/api/conftest.py` gives every pytest-xdist worker a database of its own on that server, `scholium_test_<run token>_<worker>`, and drops it when the worker exits.

**An existing server.** If `TEST_DATABASE_URL` is already set, no container is started and pytest runs against that server (this is what CI does):

```sh
TEST_DATABASE_URL=postgresql+psycopg://scholium:scholium@localhost:5432/scholium_test npm run test:pg
```

The role must be allowed to create databases, and the database in the URL must exist.

**In CI** (`.github/workflows/ci.yml`) five jobs run on every push and pull request: `npm test`, `npm run test:system`, `npm run test:pg` against a `pgvector/pgvector:pg16` service container, a build of both images from `deploy/containers/`, and `npm run infra:check`. Any failing job fails the workflow. The live LLM check ([section 9.1](#91-the-live-llm-check)) is not among them.

## 6. The worker and sandbox processes

### 6.1 The worker

```sh
python -m app.worker             # run the job loop until SIGTERM or SIGINT
python -m app.worker --once      # one pass (create due periodic jobs, drain the queue), then exit
```

In the stack it is the `worker` service. It loads every module (so every job handler registers), creates the tables, and then loops: create the current period's periodic jobs, drain the due jobs, sleep one second.

- **Many workers are safe.** A claim takes a 30-second *lease*. On PostgreSQL the candidate row is locked with `SELECT … FOR UPDATE SKIP LOCKED`; on SQLite a conditional `UPDATE` decides the winner. A runner renews its leases while a handler runs; if it dies, any runner re-queues the job when the lease expires.
- **Delivery is at least once.** A failing handler is retried with exponential backoff (2 s, 4 s, …) up to 3 attempts, then the job is `failed`.
- **Periodic jobs** are `uploads.reap` (hourly) and `follows.digest` (daily). Each carries a per-period dedupe key backed by a unique index, so any number of workers never queue a period twice.
- **Shutdown.** On SIGTERM or SIGINT it stops claiming, finishes the job in hand and exits with status 0.
- **Health.** The worker serves no port. Compose checks that it can still reach the database; a dead worker is a stopped container.

The api in `JOBS_MODE=external` only writes queued rows. If nothing runs a worker, jobs stay `queued` forever and the api does not say so: `npm run stack:smoke` catches this.

**Liveness and readiness of the api.** `GET /healthz` answers 200 while the process serves and touches no dependency, so an outage of the database never gets the api restarted for something a restart cannot fix. `GET /readyz` checks the database (`SELECT 1`) and the object store (a read-only listing) within 3 seconds in total: 200 `{"status": "ok", "checks": {"database": "ok", "object_store": "ok"}}`, or 503 with `"failing": [...]` naming each dependency that does not answer. Point a load balancer or a compose health check at `/readyz`.

### 6.2 The sandbox service

```sh
SANDBOX_TOKEN=$(openssl rand -hex 32) SANDBOX_BACKEND=podman \
  python -m app.sandbox_service --port 8001        # default 127.0.0.1:8001
```

It lets the api (and its worker) live on machines that never run a paper's code. The api talks to it when `SANDBOX_BACKEND=remote`:

| Request | Answer |
| --- | --- |
| `POST /runs` with `{"bundle_cid": "bafkrei…", "limits": {…}}` | `202 {"run_id": …, "status": "queued"}`. `401` without the bearer token, `422` for a bad CID, bad limits, a missing bundle, or bytes that do not hash to the CID, `503` when full. |
| `GET /runs/{id}` | `queued` or `running`, then `completed`, `failed`, `timeout` or `not_run`, with the log lines. Finished runs are kept for an hour. |
| `GET /healthz` | `200`, open and informationless, for container health checks. |

Every `/runs` call needs `Authorization: Bearer $SANDBOX_TOKEN`. The service fetches the bundle from its store, hashes the bytes while copying them to a private temporary file and compares with the CID, so the bytes that run are the bytes that were hashed. It starts the container exactly as `SANDBOX_BACKEND=docker` or `podman` does on the api's own node, with the same limits.

Things to know before relying on it:

- **It reads bundles from the same object store as the api.** With `STORAGE_BACKEND=fs` it reads the `CONTENT_DIR` it sees, so it must run where the api's `CONTENT_DIR` is visible. With `STORAGE_BACKEND=s3` it reads the bucket the `S3_*` variables name, through the same driver the api uses, so give it the same `S3_*` values. Any other value, or `s3` without `S3_BUCKET`, stops it at startup with status 2.
- **It needs a container engine.** The api image contains no docker or podman CLI; without one every run is reported `not_run` (with a warning at startup).
- **The bundle is untrusted code and this is the machine that runs it.** Keep it off every network but the api's, give it its own engine, and keep `SANDBOX_TOKEN` secret. The service has no database, so it cannot check the file sanitizer's verdict: the api only sends CIDs it has already cleared.

## 7. Moving an existing node with `app.migrate_backend`

`python -m app.migrate_backend` copies a running node's data to new backends (SQLite to PostgreSQL, a content directory to an S3 bucket, or both) and **proves the copy is the node it was copied from**. It copies; the source is only read and stays as it was.

**This is the way off SQLite.** SQLite is deprecated and a production start refuses SQLite and `STORAGE_BACKEND=fs` ([section 2.11](#211-what-production-refuses-to-start-without)), so a node that began on a SQLite file and a content directory moves here, to PostgreSQL and an S3 bucket, in one run. In short:

1. Stop the node and its worker, and back up the SQLite file and `CONTENT_DIR` ([7.1](#71-before-you-start)).
2. Have an empty PostgreSQL database and an empty bucket. To try it locally, `npm run stack:deps` provides both ([7.5](#75-example-a-host-install-into-the-local-stack)).
3. Run `python -m app.migrate_backend --from-db sqlite:///… --from-storage fs --from-content-dir … --to-db postgresql://… --to-storage s3 --to-s3-bucket …` with `--dry-run` first, then without it ([7.2](#72-dry-run-then-copy)).
4. Rebuild the search index, point the node at PostgreSQL and S3 with its secrets unchanged, and start it ([7.4](#74-after-the-copy)).

### 7.1 Before you start

1. **Stop the node and its worker.** The database is read in one snapshot, but the object store is not transactional, so a node that keeps writing can hand the copy a database and a set of blobs that do not belong together.
2. **Back up the source anyway** (copy the SQLite file and `CONTENT_DIR`).
3. **Make an empty target.** The target database must hold **no row in any table**, and be a different database from the source. A freshly created, empty database is right. A database the application has *already started against* is not: the first start inserts a bookkeeping row, and the migration refuses it (`the target database is not empty: table content_ref_progress holds 1 row`). The tool creates the schema itself, with the same code the application uses, so the append-only triggers on `event_log` and the search index are built in the target dialect.
4. **Have the target bucket ready** (empty, with credentials that can write, read and delete).
5. **Carry the secrets and the node key.** The tool copies database rows and blobs, nothing else. Keep the source node's `NODE_KEY` (or copy its `NODE_KEY_PATH` file), `JWT_SECRET`, `REVIEW_UNIQUENESS_KEY` and `COMMITTEE_PUBLIC_KEY` unchanged on the new node, or the node signs as a different identity, sessions end and earlier reviews stop matching their authors.

### 7.2 Dry run, then copy

Run from `apps/api`. A dry run writes nothing (a missing SQLite file is not created, nothing reaches the target storage) and reads no blob bytes; it reports what would move:

```sh
uv run --all-packages python -m app.migrate_backend \
    --from-db sqlite:///./scholium.db --from-storage fs --from-content-dir ./data/content \
    --to-db postgresql://scholium:PASSWORD@127.0.0.1:5433/scholium \
    --to-storage s3 --to-s3-bucket scholium \
    --to-s3-endpoint-url http://127.0.0.1:9000 --to-s3-region us-east-1 \
    --dry-run
```

```text
source database: sqlite:///./scholium.db
target database: postgresql+psycopg://scholium:***@127.0.0.1:5433/scholium (empty)
source storage: fs (./data/content)
target storage: s3 (bucket scholium at http://127.0.0.1:9000)
dry run: nothing is written
tables: 50 with 1 rows
  content_ref_progress: 1
event_log: 0 entries, head seq 0, hash chain intact
blobs: 1 objects, 14 bytes
```

(Counts are those of an empty node; yours will be larger.) Passwords in URLs are never printed. Because the source is SQLite, the tool also logs the one-line SQLite deprecation warning quoted at the top of this guide; that is expected. Leave out `--dry-run` to copy. S3 credentials never travel on the command line: put them in the environment, per side:

```sh
export MIGRATE_TO_S3_ACCESS_KEY_ID=...        # falls back to S3_ACCESS_KEY_ID
export MIGRATE_TO_S3_SECRET_ACCESS_KEY=...    # falls back to S3_SECRET_ACCESS_KEY
export MIGRATE_TO_S3_FORCE_PATH_STYLE=1       # MinIO and most self-hosted servers
```

(`MIGRATE_FROM_S3_*` is the same for the source side.) The whole option list is in `python -m app.migrate_backend --help`: `--from-db`, `--to-db`, `--from-storage` and `--to-storage` (`fs` or `s3`) are required; each side has `-content-dir`, `-s3-bucket`, `-s3-endpoint-url` and `-s3-region` overrides, defaulting to `CONTENT_DIR` and the `S3_*` variables. When both sides name the same storage (moving only the database) no blob is copied, and every blob is still verified in place.

### 7.3 What it does, in order

1. Refuses a non-empty target (and a source that is the target). Nothing has been written when this fails.
2. Checks the source without writing: every table is one this version knows, and the `event_log` hash chain is intact from `seq` 1. A node whose log is already broken is not copied.
3. Creates the schema on the target.
4. Copies every table in dependency order, in batches, each in one transaction. `event_log` goes in `seq` order with `raw` and the hashes exactly as bytes; on PostgreSQL the identity and serial sequences are moved past the copied ids, so the next append does not collide.
5. Copies every blob: read once into a scratch file while hashed; a blob whose bytes do not hash to the CID it is stored under stops the run, naming that CID, with nothing written for it. What the target stored is checked against the same hash.
6. Re-verifies the target: row counts of every table, the whole hash chain row by row against the source (naming the first `seq` that differs), and every blob read back and hashed against its CID.

Any failure exits non-zero with `migrate_backend: error: …` on stderr. Once step 3 has run, the target may hold a partial copy; discard it (drop and recreate the database, empty the bucket) before trying again. A migration never resumes into a partial copy, since step 1 would refuse it.

### 7.4 After the copy

1. **SQLite to PostgreSQL only: rebuild the search index.** The index is derived data, copied on the columns both dialects have. PostgreSQL also indexes author names, which SQLite does not keep:

   ```sh
   DATABASE_URL=postgresql://scholium:PASSWORD@127.0.0.1:5433/scholium \
     uv run --all-packages python -c "from app.modules.search import rebuild_index; print(rebuild_index())"
   ```

2. **Point the node at the new backends:** `DATABASE_URL`, `STORAGE_BACKEND=s3` and the `S3_*` variables ([sections 2.2](#22-database-backend) and [2.3](#23-object-storage-backend)), together with the unchanged secrets from [7.1](#71-before-you-start). A production node needs exactly these two backends to start at all ([section 2.11](#211-what-production-refuses-to-start-without)). Start the api and the worker.
3. **Check:** `GET /readyz` returns 200, and the papers you know are there.
4. Keep the source until you are satisfied. The migration did not change it.

### 7.5 Example: a host install into the local stack

```sh
# 1. Start only the services that hold data. Do not start api or worker yet:
#    they would write to the empty database and make it "not empty".
npm run stack:deps

# 2. Dry run, then the copy (section 7.2), with MIGRATE_TO_S3_* set to the MinIO
#    credentials from .env (MINIO_ROOT_USER / MINIO_ROOT_PASSWORD by default).

# 3. Give the stack the node's identity (NODE_KEY and the secrets in .env), then:
npm run stack:up
npm run stack:smoke
```

The stack's `db` service creates its database empty on first start, which is exactly what the target must be, and `stack:deps` returns only once the bucket exists, so the copy can start as soon as it does. With the stack's defaults the target of step 2 is:

```sh
export MIGRATE_TO_S3_ACCESS_KEY_ID=scholium-minio
export MIGRATE_TO_S3_SECRET_ACCESS_KEY=scholium-minio-secret
export MIGRATE_TO_S3_FORCE_PATH_STYLE=1
#   --to-db postgresql://scholium:scholium-local-only@127.0.0.1:5433/scholium
#   --to-storage s3 --to-s3-bucket scholium
#   --to-s3-endpoint-url http://127.0.0.1:9000 --to-s3-region us-east-1
```

## 8. Staging with OpenTofu

`infra/envs/staging` provisions a staging node on real infrastructure with [OpenTofu](https://opentofu.org) (the open-source, Terraform-compatible fork; the files are plain HCL). It composes the modules under `infra/modules` and runs the repository's own `compose.yaml` on a VM. The modules, their outputs and the provider pins are documented in `infra/README.md`; this section is the walkthrough.

### 8.1 What gets created

| Piece | Module | Provider | What it is |
| --- | --- | --- | --- |
| Host | `host-vm` | Hetzner Cloud | One server (default `cx22`, Ubuntu 24.04, podman 4.9), one volume mounted at `/srv/scholium`, and a firewall that opens **SSH only**. Cloud-init installs podman and podman-compose, clones the repository, writes the stack's `.env` (mode 0600) and runs `compose.yaml` as the systemd unit `scholium-stack.service`. |
| Objects | `object-store-s3` or `object-store-r2` (one, chosen by `object_store_provider`) | AWS or Cloudflare | A private bucket and a credential scoped to that bucket alone. Both modules expose the same five outputs, so the application settings keep their names whichever you pick. |
| Edge | `edge-cloudflare` | Cloudflare | A Cloudflare Tunnel from the API hostname to the host, a proxied DNS record, and a rate-limit rule (default 100 requests per 10 s per client IP). The tunnel is outbound-only: the host needs no open inbound port. |

OpenTofu generates the database password, `JWT_SECRET`, `REVIEW_UNIQUENESS_KEY` and the node signing key (`NODE_KEY`) itself; they live only in the encrypted state and in the host's `.env`. `SCHOLIUM_ENV` is `production`, so the application's production checks ([section 2.11](#211-what-production-refuses-to-start-without)) apply.

### 8.2 What you need first

- OpenTofu 1.9 or newer (`tofu version`).
- **Hetzner Cloud**: a project, an API token with read and write access (`HCLOUD_TOKEN`), and an SSH key already uploaded to that project (its name goes into `ssh_keys`).
- **Cloudflare**: the account id, a zone in that account (its zone id), and an API token (`CLOUDFLARE_API_TOKEN`) with Cloudflare Tunnel Edit (account), DNS Edit and Zone WAF Edit (zone); for R2 also Account API Tokens Write and Workers R2 Storage Write.
- **AWS** (only for `object_store_provider = "s3"`): credentials allowed to create S3 buckets, IAM users, access keys and policies.
- **A bucket for the OpenTofu state**, on any S3-compatible service, created beforehand with its own credentials. This configuration does not create it.
- Application values: the committee public key (32 bytes, hex or base64), an SMTP URL, an ORCID client id and secret, and an Anthropic API key (or `ai_provider = "ollama"`).

### 8.3 Walkthrough

**1. Check the configuration offline.** No credentials needed; `init` only downloads the pinned providers:

```sh
npm run infra:check
```

It runs `tofu fmt -check -recursive infra`, then `tofu init -backend=false` and `tofu validate` for every directory that holds `.tf` files, and removes the generated `.terraform/` directories again. It exits 127 if `tofu` is not installed.

**2. Put the secrets in the environment**, never in a file in the repository:

```sh
export HCLOUD_TOKEN=...                                 # Hetzner
export CLOUDFLARE_API_TOKEN=...                         # Cloudflare
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...  # only when object_store_provider = "s3"
export TF_VAR_state_encryption_passphrase=...           # at least 16 characters; losing it loses the state
export TF_VAR_smtp_url=...
export TF_VAR_orcid_client_secret=...
export TF_VAR_anthropic_api_key=...
```

**3. Write the non-secret inputs** to a variables file **outside the repository** (or untracked), for example `~/scholium-staging.tfvars`:

```hcl
ssh_keys              = ["my-hetzner-ssh-key"]
cloudflare_account_id = "0123456789abcdef0123456789abcdef"   # placeholder
cloudflare_zone_id    = "fedcba9876543210fedcba9876543210"   # placeholder
api_hostname          = "api.staging.example.org"
committee_public_key  = "<32 bytes, hex or base64>"
orcid_client_id       = "APP-XXXXXXXXXXXXXXXX"
object_bucket_name    = "example-scholium-staging-content"    # S3 names are globally unique
ssh_allowed_cidrs     = ["203.0.113.7/32"]                    # the default is the whole internet
```

The full list, with defaults and validation, is `infra/envs/staging/variables.tf`. Useful ones: `object_store_provider` (`s3` or `r2`), `r2_jurisdiction`, `aws_region` (default `eu-central-1`), `server_type`, `location`, `repository_url` and `repository_ref` (what the host deploys, default `main`), `sandbox_backend` (default `none`), `web_origins`, `site_url`, and `stack_environment` (extra or overriding variables for the stack's `.env`, such as `FORWARDED_ALLOW_IPS`).

`ai_provider` accepts only `anthropic` or `ollama`. For `AI_PROVIDER=openai`, or for an Anthropic-protocol server at another address, set the variables of [Choosing an AI provider](#choosing-an-ai-provider) in `stack_environment`: it is applied after everything else, so it overrides `ai_provider`, and the variable is marked `sensitive`, so the API key it carries stays out of plan output (it is stored in the encrypted state like every other secret).

**4. Initialise with the state backend.** OpenTofu cannot read variables inside a backend block, so the provider-specific parts are given at init time (this is the form documented in `infra/envs/staging/backend.tf`, here for Cloudflare R2):

```sh
cd infra/envs/staging
tofu init \
  -backend-config="bucket=scholium-tofu-state" \
  -backend-config="key=scholium/staging/terraform.tfstate" \
  -backend-config="region=auto" \
  -backend-config="endpoints={s3=\"https://<account>.r2.cloudflarestorage.com\"}" \
  -backend-config="skip_credentials_validation=true" \
  -backend-config="skip_region_validation=true" \
  -backend-config="skip_requesting_account_id=true"
```

The state and saved plans are encrypted client-side (AES-GCM, key derived from the passphrase with PBKDF2), and `enforced = true` makes OpenTofu refuse unencrypted state. The state bucket's credentials are read from the environment by the S3 backend; if they differ from the AWS credentials used for the content bucket, give the backend its own profile with an extra `-backend-config="profile=..."`.

**5. Plan, read it, apply:**

```sh
tofu plan  -var-file=$HOME/scholium-staging.tfvars -out=staging.plan
tofu apply staging.plan
```

Do not commit `staging.plan` or any state file.

**6. Read the outputs:**

```sh
tofu output api_url
tofu output host_ipv4_address
tofu output ssh_command
tofu output s3_bucket
```

No secret is an output. The generated secrets are in the encrypted state and in `/srv/scholium/app/.env` on the host.

**7. Wait for the first boot.** Cloud-init installs the packages, mounts the volume, clones `repository_ref` into `/srv/scholium/app`, builds the images and starts the stack; the first build takes several minutes. Follow it on the host:

```sh
ssh root@<host_ipv4_address>
cloud-init status --wait
journalctl -u scholium-stack -f
cd /srv/scholium/app
export COMPOSE_PROJECT_NAME=scholium-staging   # scholium-<environment_name>, as the systemd unit sets it
podman-compose ps
```

Run any `podman-compose` command on the host with that `COMPOSE_PROJECT_NAME`, or it will not see the stack's containers.

**8. Verify.**

```sh
curl -fsS "$(tofu output -raw api_url)/readyz"
# {"status":"ok","checks":{"database":"ok","object_store":"ok"}}
```

and, on the host, the same end-to-end check the local stack uses (the host has no npm, so call the script's last step directly):

```sh
cd /srv/scholium/app && podman-compose exec -T api python -m app.smoke   # ends with a line "smoke: OK"
```

**9. Deploy a new version.** On the host, `systemctl restart scholium-stack` stops the stack, fetches the latest `repository_ref`, rebuilds and starts it again. Changing a stack variable, `repository_ref` or the tunnel token in OpenTofu changes the server's cloud-init, which Hetzner only reads at creation, so the apply **replaces the server** (see the warning below).

**10. Tear down:** `tofu destroy -var-file=$HOME/scholium-staging.tfvars`. A non-empty AWS bucket is not deleted unless `object_store_force_destroy = true`.

### 8.4 Read this before you rely on staging

- **PostgreSQL's data is on the server's own disk, not on the data volume.** Cloud-init formats and mounts the Hetzner volume at `/srv/scholium` and checks the repository out there, but it does not move podman's storage, so the compose named volumes (`db-data`, `app-data`) live in podman's default location. Replacing the server (any cloud-init change, see step 9) or destroying it loses the database. Take a dump first (`podman-compose exec -T db pg_dump -U scholium scholium > scholium.sql`, with the user and database names of `database_user` and `database_name`) and copy it off the host, and treat staging data as disposable until backups are in place. The blobs are safe: they are in the bucket.
- **The unit starts the stack with one `podman-compose up -d`.** `scholium-stack.service` runs `podman-compose up -d --remove-orphans --build` as a single command, not the staged start of `npm run stack:up` (the host has no npm; [section 4.4](#44-npm-scripts)). [Section 4.4](#44-npm-scripts) explains why podman 4.9 can leave the api and worker unstarted that way. After the first boot, confirm with `podman-compose ps` (step 7) that `api` and `worker` are running before you rely on the node; `journalctl -u scholium-stack` shows the error if they are not.
- **Only the API hostname is published.** The tunnel routes `api_hostname` to the API port and answers 404 for anything else. The web container runs on the host's `127.0.0.1:3000` but nothing in this environment exposes it, and `site_url` and `web_origins` default to the API hostname. Publishing the web app needs an extra ingress rule and DNS record, and `site_url`, `web_origins` and a rebuilt web image (`NEXT_PUBLIC_*` are baked in at build time) to match.
- **Secrets are in the state.** The generated passwords and keys, the Anthropic key, the SMTP URL and the tunnel token are stored in the state, encrypted. Keep the passphrase safe, restrict who can read the state bucket, and never commit state or plan files.
- **Narrow `ssh_allowed_cidrs`.** The default opens SSH to every address.
- **Leave the sandbox off.** `sandbox_backend = "remote"` needs the sandbox service, which can read the bucket but has no container engine in the stack's image, so it would report every run `not_run` ([section 6.2](#62-the-sandbox-service)).
- **Switching `object_store_provider`** provisions a new, empty bucket. Copying existing blobs across means a full migration into an empty database as well ([section 7](#7-moving-an-existing-node-with-appmigrate_backend)); the tool always copies the database with the objects.

## 9. Opt-in commands outside `npm test`

`npm test` needs no containers, network or cloud credentials. These commands do, so they are scripts you run on purpose, and CI runs them as separate jobs:

| Command | Needs | What it checks |
| --- | --- | --- |
| `npm run test:pg` | podman-compose or docker compose, uv | The whole API suite on PostgreSQL 16 ([section 5](#5-the-postgresql-test-lane)). |
| `npm run stack:up` | podman-compose (1.6.0 or newer) or docker compose | Builds the images and starts the local stack, in stages ([section 4](#4-the-local-podman-stack)). Its companions: `stack:down`, `stack:logs`, `stack:reset`. |
| `npm run stack:deps` | podman-compose (1.6.0 or newer) or docker compose | Starts only PostgreSQL, MinIO, Mailpit and the bucket, for running the API on the host ([section 3.2](#32-against-postgresql-and-s3-with-npm-run-stackdeps)). |
| `npm run stack:smoke` | the stack running, curl | Readiness of the api and web, a blob round trip through S3 and a job done by the separate worker. |
| `npm run infra:check` | `tofu` | OpenTofu formatting and validation of everything under `infra/`, without credentials ([section 8](#8-staging-with-opentofu)). |
| `npm run test:llm-live` | network, a real LLM endpoint and key, `op` (the 1Password CLI) | Both hosted AI providers against that endpoint ([section 9.1](#91-the-live-llm-check)). The only command that calls a real LLM. |

Two more are opt-in only because of their cost, not their needs. Neither uses a container, the network beyond loopback, or a credential:

| Command | Needs | What it checks |
| --- | --- | --- |
| `npm run test:system` | uv, and `npm install` for the web part | The shipped programs end to end, in `tests/e2e/` ([its README](../tests/e2e/README.md)): `python -m app`, `app.worker`, `app.sandbox_service`, `app.migrate_backend`, the admin commands and `next build` + `next start`, started as processes and driven over HTTP, SMTP and the command line, on SQLite with the filesystem store and with an S3 endpoint. About three minutes; `-m "not web"` leaves out the Next.js build. |
| `npm run test:e2e` | `npx playwright install chromium` | The browser journeys, in a real browser against the API and a production build of the web app. |

Both run on SQLite. The one system test that boots a complete production configuration needs PostgreSQL, because production refuses SQLite, so it runs only when `TEST_DATABASE_URL` names a server ([section 5](#5-the-postgresql-test-lane)) and is skipped otherwise.

### 9.1 The live LLM check

`npm run test:llm-live` sends one small request through each hosted provider, `anthropic` and `openai`, to a real endpoint and checks the answer. It is the only test that calls a real LLM, so it is opt-in twice over: pytest's `live_llm` marker is excluded by default (`addopts` in `apps/api/pyproject.toml`), so `npm test`, `npm run test:pg`, `npm run test:system` and CI never run it; and its tests skip unless the endpoint is configured. It makes two requests, each allowed up to 2,048 output tokens, so it costs a little each time.

Run it through `op run`, which resolves the 1Password references in `deploy/llm-live.env.tpl` and injects the values into that one command only; nothing is written to disk:

```sh
op run --env-file=deploy/llm-live.env.tpl -- npm run test:llm-live
```

It needs the 1Password CLI signed in (or a service account token in the environment) and network access to the endpoint. The template holds `op://` references and no secret; edit them, and the model id, to point at your own item. It sets:

| Variable | Meaning |
| --- | --- |
| `LLM_LIVE_BASE_URL` | Root of the endpoint. Used as it is for the `anthropic` provider (the value you would give `ANTHROPIC_BASE_URL`), and with `/v1` appended for the `openai` provider unless the next variable is set. |
| `LLM_LIVE_API_KEY` | **Secret.** The key, for both providers. |
| `LLM_LIVE_MODEL` | The model id, taken from the provider's documentation. |
| `LLM_LIVE_OPENAI_BASE_URL` | Optional, not in the template. The full base URL for the `openai` provider when it is not `LLM_LIVE_BASE_URL` plus `/v1`. |

The names are `LLM_LIVE_*` rather than `ANTHROPIC_*` or `OPENAI_*` on purpose: injecting them cannot reroute any other tool that reads those names. A gateway that serves both protocols under one root fits the template as it is. DeepSeek serves them at different roots, so set `LLM_LIVE_BASE_URL=https://api.deepseek.com/anthropic` and `LLM_LIVE_OPENAI_BASE_URL=https://api.deepseek.com`. Without 1Password, export the three variables from your own secret store and run `npm run test:llm-live`.

Each test sends a listed request with one quoted data block through the provider and asserts that the reply is not empty, that the model the endpoint reports is `LLM_LIVE_MODEL` (an endpoint that reports another name fails the check), and that no thinking block (Anthropic protocol) or `reasoning_content` (OpenAI protocol) leaked into the returned text. The key goes only to the provider and appears in no output. If any of the three variables is missing, both tests are **skipped** with the reason; a skipped run checked nothing.

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Unsafe production configuration: …` at startup | `SCHOLIUM_ENV=production` with a development default. The message lists every problem ([section 2.11](#211-what-production-refuses-to-start-without)). |
| `Unsafe production configuration: DATABASE_URL must be a PostgreSQL URL in production (SQLite is deprecated); …` | A production start on SQLite, or with `DATABASE_URL` unset. Point it at PostgreSQL; to keep an existing node's data, move it first ([section 7](#7-moving-an-existing-node-with-appmigrate_backend)). |
| `Unsafe production configuration: … STORAGE_BACKEND must be s3 in production; …` | A production start on `STORAGE_BACKEND=fs`. Use `s3` with `S3_BUCKET` and the two keys; move existing blobs with [section 7](#7-moving-an-existing-node-with-appmigrate_backend). |
| `Unknown JOBS_MODE 'x'; expected one of eager, thread, external.` (same for `STORAGE_BACKEND`, `SCHOLIUM_ENV`) | A typo. These are refused instead of guessed at. |
| `Unknown AI_PROVIDER 'x'; expected one of fake, anthropic, openai, ollama.` | A typo, or a vendor name: the ids name protocols. For another vendor use `openai` or `anthropic` with a base URL ([section 2.7](#27-mail-orcid-arxiv-crossref-and-ai)). |
| `openai provider: HTTP 404 from POST …/chat/completions` (or another 4xx) | `OPENAI_BASE_URL` or the model is wrong. The provider appends `/chat/completions` to the base URL, so a missing or extra `/v1` is the usual cause; 401 means the key. The same holds for `anthropic` with `ANTHROPIC_BASE_URL`, where the SDK appends `/v1/messages`. |
| `PrivateDraftError: hosted provider …` | An unlisted draft was sent to `anthropic` or `openai`. Hosted providers take listed papers only ([section 2.7](#27-mail-orcid-arxiv-crossref-and-ai)). |
| A `WARNING: SQLite is deprecated; …` line in the log | The process opened a SQLite database. Expected in tests and local development; production refuses SQLite. |
| `GET /readyz` returns 503 with `"failing": ["object_store"]` | Wrong endpoint, credentials or bucket. In the stack, check that `minio-init` exited successfully (`podman ps -a`) and the `S3_*` values. The response never says why; the api log does. |
| `GET /readyz` returns 503 with `"failing": ["database"]` | `DATABASE_URL` is wrong or the server is down. In the stack, `db` must be healthy. |
| Jobs stay `queued` | Nothing is running a worker. In `JOBS_MODE=external` the api never runs jobs. Start `python -m app.worker`, or check the `worker` container. |
| `stack-compose: podman-compose 1.5.0 is older than 1.6.0.` (any version below 1.6.0) | Every `stack:*` script needs podman-compose 1.6.0 or newer ([section 4.1](#41-prerequisites)). Upgrade with `pipx install podman-compose`, or use `STACK_COMPOSE="docker compose"`. |
| `stack-up-staged: FAILED: <service> was not healthy after 300s` (or `had not exited with status 0`) | The service named did not come up. `npm run stack:logs -- <service>` shows why; a slow machine may need a larger `STACK_UP_TIMEOUT` ([section 4.4](#44-npm-scripts)). For `minio-init` the status is the one it exited with, and it does not run again. |
| `generating dependency graph … not found in input list` when starting `api` or `worker` | podman 4.9 refuses to start a service whose `depends_on` names an exited one-shot (`minio-init`). Start the stack with `npm run stack:up`, which starts it in stages, not with a plain `up` ([section 4.4](#44-npm-scripts)). |
| `npm run test:llm-live` reports every test skipped | `LLM_LIVE_BASE_URL`, `LLM_LIVE_API_KEY` or `LLM_LIVE_MODEL` is not set. Run it through `op run --env-file=deploy/llm-live.env.tpl` ([section 9.1](#91-the-live-llm-check)). |
| `stack:smoke` fails at `readyz` or `web` | The stack is not up yet (wait, or `npm run stack:up`) or a dependency is down; the message includes the body of `/readyz`. |
| `stack:smoke` fails at `api smoke` on the job step | The worker is not claiming jobs: `npm run stack:logs -- worker`. |
| The web app calls the wrong API address | `NEXT_PUBLIC_API_URL` is baked in at build time. Change it and run `npm run stack:up` again so the web image is rebuilt. |
| Browser blocks API calls (CORS) | `WEB_ORIGINS` does not list the page's exact origin. |
| `migrate_backend: error: the target database is not empty` | The application has started against it. Use a freshly created database ([section 7.1](#71-before-you-start)). |
| `test:pg` cannot start a database | Neither `podman-compose` nor `docker compose` is installed, or the image could not be pulled. Set `TEST_DATABASE_URL` to use a server you already have. |
| `sandbox service: STORAGE_BACKEND='s3' is not usable: S3_BUCKET is not configured` | The service reads through the same `S3_*` variables as the api; give it the api's values ([section 6.2](#62-the-sandbox-service)). |
| `infra:check` says `OpenTofu ('tofu') is not installed` | Install it from https://opentofu.org/docs/intro/install/. |
| `tofu validate` fails with "Failed to read any lines from plugin's stdout" | `$TMPDIR` is too long for a Unix socket path. Run with a short one, for example `TMPDIR=. tofu validate`. |
| Stack ports already in use | Set `API_PORT`, `WEB_PORT`, `DB_PORT`, `MINIO_PORT`, … in `.env`; after `API_PORT` or `WEB_PORT` also update `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL` and `WEB_ORIGINS`. |
