#!/usr/bin/env bash
#
# Run the whole API test suite against PostgreSQL 16 (with pgvector), the way
# CI does it.
#
#   npm run test:pg                 start a throwaway database, run pytest, remove it
#   npm run test:pg -- -k ledger    extra arguments are passed to pytest
#
# TEST_DATABASE_URL already set (CI): no container is started. pytest runs
# against that server, and apps/api/conftest.py provisions one database per
# xdist worker there and drops it again afterwards.
#
# Otherwise the script starts deploy/compose/compose.test.yaml with
# podman-compose (falling back to `docker compose`) under a compose project
# name unique to this invocation, on a free loopback port, waits for the
# healthcheck to pass, and runs pytest with TEST_DATABASE_URL pointing at it.
# The container is removed on exit -- also when pytest fails or the run is
# interrupted.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "==> TEST_DATABASE_URL is set; using that server (no container)"
  cd apps/api || exit 1
  exec uv run --all-packages pytest "$@"
fi

compose_file="deploy/compose/compose.test.yaml"

# podman-compose when it is installed, `docker compose` otherwise. COMPOSE
# overrides the probe, e.g. COMPOSE="docker compose" on a machine with both.
engine=""
COMPOSE_CMD=()
if [ -n "${COMPOSE:-}" ]; then
  read -r -a COMPOSE_CMD <<< "$COMPOSE"
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(podman-compose)
elif docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
else
  echo "test-pg: podman-compose or 'docker compose' is required (or export TEST_DATABASE_URL)" >&2
  exit 127
fi
case "${COMPOSE_CMD[0]}" in
  *docker*) engine=docker ;;
  *) engine=podman ;;
esac

if ! command -v uv >/dev/null 2>&1; then
  echo "test-pg: uv is required (https://docs.astral.sh/uv/)" >&2
  exit 127
fi

python_bin="${PYTHON:-}"
if [ -z "$python_bin" ]; then
  if command -v python3 >/dev/null 2>&1; then
    python_bin=python3
  else
    python_bin=python
  fi
fi
if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "test-pg: python3 is required to pick a free port" >&2
  exit 127
fi

# A free loopback port for this run. Binding it (then letting go) is the most
# portable free-port test there is; the race between close and compose's bind
# is tiny, and up is retried on a fresh port if it loses.
pick_port_and_token() {
  "$python_bin" - <<'PY'
import secrets
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
print(port, secrets.token_hex(3))
PY
}

read -r port run_token < <(pick_port_and_token)
if [ -z "${port:-}" ] || [ -z "${run_token:-}" ]; then
  echo "test-pg: could not pick a free port" >&2
  exit 1
fi

# One compose project (and one database) per invocation, so two test:pg runs on
# one machine never share a container. The conftest uses the same token in
# every per-worker database name.
project="scholium-test-$(date +%s)-$$-${RANDOM}"
export COMPOSE_PROJECT_NAME="$project"
export SCHOLIUM_TEST_PG_PORT="$port"
export SCHOLIUM_TEST_RUN_TOKEN="$run_token"

compose=("${COMPOSE_CMD[@]}" -p "$project" -f "$compose_file")

started=0
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ "$started" -eq 1 ]; then
    echo "==> removing the test database (project $project)"
    "${compose[@]}" down --remove-orphans --volumes >/dev/null 2>&1 || true
    # podman-compose has been known to leave a container behind when the
    # runtime is interrupted mid-run; the project label finds it either way.
    local leftovers
    leftovers="$("$engine" ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)"
    if [ -z "$leftovers" ]; then
      # Older podman-compose builds label containers differently; both naming
      # schemes start with the project name.
      leftovers="$("$engine" ps -aq --filter "name=$project" 2>/dev/null || true)"
    fi
    if [ -n "$leftovers" ]; then
      # shellcheck disable=SC2086  # word splitting is the point
      "$engine" rm -f $leftovers >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

started=1
attempt=0
until "${compose[@]}" up -d; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 3 ]; then
    echo "test-pg: could not start the database container" >&2
    exit 1
  fi
  echo "test-pg: start failed; retrying on another port" >&2
  "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
  read -r port run_token < <(pick_port_and_token)
  export SCHOLIUM_TEST_PG_PORT="$port"
  export SCHOLIUM_TEST_RUN_TOKEN="$run_token"
done

container=""
for _ in $(seq 1 30); do
  container="$("$engine" ps -aq \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=db" 2>/dev/null | head -n 1)"
  if [ -z "$container" ]; then
    # Fallback for compose implementations that name rather than label.
    container="$("$engine" ps -aq --filter "name=${project}" 2>/dev/null | head -n 1)"
  fi
  [ -n "$container" ] && break
  sleep 1
done
if [ -z "$container" ]; then
  echo "test-pg: the database container is not running" >&2
  exit 1
fi

echo "==> waiting for PostgreSQL to be healthy (127.0.0.1:$port)"
health="starting"
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
  health="$("$engine" inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$container" 2>/dev/null || echo unknown)"
  case "$health" in
    healthy) break ;;
    unhealthy | exited | dead)
      echo "test-pg: the database container did not become healthy ($health)" >&2
      exit 1
      ;;
  esac
  sleep 1
done
if [ "$health" != "healthy" ]; then
  echo "test-pg: timed out waiting for PostgreSQL to become healthy" >&2
  exit 1
fi

export TEST_DATABASE_URL="postgresql+psycopg://scholium:scholium@127.0.0.1:${port}/scholium_test"
echo "==> PostgreSQL is healthy; running the API suite against it"
cd apps/api || exit 1
uv run --all-packages pytest "$@"
