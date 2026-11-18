#
# Scholium API image.
#
# Build from the repository root (the uv workspace lives in apps/api):
#
#   podman build -f deploy/containers/api.Containerfile -t scholium-api .
#   docker build -f deploy/containers/api.Containerfile -t scholium-api .
#
# The image serves `python -m app` by default. The worker and the sandbox
# service are the same code with a different entrypoint, so compose starts them
# by overriding the command instead of building a second image:
#
#   podman run --rm scholium-api python -m app.worker
#   podman run --rm scholium-api python -m app.sandbox_service

FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.title="scholium-api" \
      org.opencontainers.image.description="Scholium API, worker and sandbox service" \
      org.opencontainers.image.source="https://github.com/scholium/scholium"

# uv resolves and installs the workspace; copy its static binary so the build
# does not need pip or a compiler. Pinned to the version that wrote uv.lock.
COPY --from=ghcr.io/astral-sh/uv:0.10.0 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/apps/api/.venv \
    PATH="/app/apps/api/.venv/bin:$PATH"

WORKDIR /app

# Dependency layer: only the manifests and the workspace members, so changing
# application code does not re-resolve or re-download the environment.
#
# --chmod=a+rX because the build context is a checkout, and a checkout made
# under umask 007 leaves its files mode 660 (owner/group only). uid 10001 runs
# the container and is neither the owner nor in that group, so without this it
# cannot read the sources: the API fails with "No module named app.__main__"
# and the worker with "No module named app.worker", so /healthz never answers.
# X grants execute only to directories; ordinary files stay non-executable.
COPY --chmod=a+rX apps/api/pyproject.toml apps/api/uv.lock ./apps/api/
COPY --chmod=a+rX apps/api/packages ./apps/api/packages
RUN uv sync --frozen --no-dev --all-packages --project apps/api --no-install-project

# Application layer.
COPY --chmod=a+rX apps/api/src ./apps/api/src
RUN uv sync --frozen --no-dev --all-packages --project apps/api

# One unprivileged account owns the mutable state. A fixed uid/gid keeps bind
# mounts and named volumes usable under rootless podman and Docker.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --home-dir /home/app \
        --shell /usr/sbin/nologin app \
    && mkdir -p /data/content \
    && chown -R app:app /data

# Container-friendly defaults. HOST=0.0.0.0 is what makes the uvicorn socket
# reachable from outside the container; the data paths live on the /data
# volume, and compose (or the operator) supplies DATABASE_URL. SQLite is the
# development default and is refused in production.
ENV HOST=0.0.0.0 \
    PORT=8000 \
    CONTENT_DIR=/data/content \
    NODE_KEY_PATH=/data/node.key

USER app

VOLUME ["/data"]
EXPOSE 8000

# No HEALTHCHECK here: the same image also runs the worker and the sandbox
# service, which do not serve HTTP. compose.yaml healthchecks the API service.
CMD ["python", "-m", "app"]
