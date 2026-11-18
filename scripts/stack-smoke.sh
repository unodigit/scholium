#!/usr/bin/env bash
#
# Verify the running local stack (start it first with npm run stack:up).
#
#   npm run stack:smoke
#   npm run stack:smoke -- --job-timeout 120    extra arguments go to python -m app.smoke
#
# Three steps, in order; the first that fails ends the run with a non-zero exit
# status and a message that names it:
#
#   1. readyz     wait for GET /readyz on the api to return 200 (the database and
#                 the object store answer);
#   2. web        wait for GET / on the web app to return 200;
#   3. api smoke  run `python -m app.smoke` inside the api container: write and read
#                 back a blob through the S3 store, then create a system.ping job
#                 and wait for the separate worker container to mark it done.
#
# Steps 1 and 2 retry for up to STACK_SMOKE_TIMEOUT seconds each (default 180),
# because a stack that has only just come up is not ready at once. Step 3 does not
# retry; its own timeout for the worker is --job-timeout (default 60 seconds).
#
# The addresses are http://127.0.0.1:$API_PORT and $WEB_PORT (defaults 8000 and
# 3000), taken from the environment or from .env like compose does. The container
# engine is chosen as stack:up chooses it: STACK_COMPOSE, else podman-compose when
# installed, else `docker compose`.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

fail() { # fail STEP MESSAGE
  echo "stack-smoke: FAILED at step '$1': $2" >&2
  exit 1
}

# The value of a setting the way compose resolves it: the environment first, then
# .env next to compose.yaml, then the default. Only the last assignment counts, a
# surrounding quote pair and a trailing comment are dropped.
setting() { # setting NAME DEFAULT
  local name=$1 default=$2 value="${!1:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=[[:space:]]*//p" .env | tail -n 1)"
    value="${value#[\"\']}"
    value="${value%%[[:space:]#\"\']*}"
  fi
  printf '%s' "${value:-$default}"
}

COMPOSE_CMD=()
if [ -n "${STACK_COMPOSE:-}" ]; then
  read -r -a COMPOSE_CMD <<< "$STACK_COMPOSE"
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(podman-compose)
elif docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
else
  echo "stack-smoke: podman-compose or 'docker compose' is required (or set STACK_COMPOSE)" >&2
  exit 127
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "stack-smoke: curl is required" >&2
  exit 127
fi

timeout="${STACK_SMOKE_TIMEOUT:-180}"
case "$timeout" in
  '' | *[!0-9]* | 0)
    echo "stack-smoke: STACK_SMOKE_TIMEOUT must be a whole number of seconds, not '$timeout'" >&2
    exit 2
    ;;
esac

api_port="$(setting API_PORT 8000)"
web_port="$(setting WEB_PORT 3000)"
for port in "$api_port" "$web_port"; do
  case "$port" in
    '' | *[!0-9]*)
      echo "stack-smoke: '$port' is not a port number (API_PORT and WEB_PORT)" >&2
      exit 2
      ;;
  esac
done

body="$(mktemp)"
log="$(mktemp)"
trap 'rm -f "$body" "$log"' EXIT

# Poll URL until it answers 200, or fail STEP once STACK_SMOKE_TIMEOUT has passed.
wait_for_200() { # wait_for_200 STEP URL
  local step=$1 url=$2 code last="" deadline=$((SECONDS + timeout))
  echo "==> $step: waiting for GET $url to return 200 (up to ${timeout}s)"
  while :; do
    code="$(curl -s -o "$body" -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)" || true
    [ -n "$code" ] || code=000
    if [ "$code" = 200 ]; then
      echo "    ok"
      return 0
    fi
    if [ "$code" != "$last" ]; then
      if [ "$code" = 000 ]; then echo "    no answer yet"; else echo "    HTTP $code, retrying"; fi
      last=$code
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 2
  done

  local message="GET $url did not return 200 within ${timeout}s"
  if [ "$code" = 000 ]; then
    message="$message (no answer: is the stack up? try npm run stack:up)"
  else
    message="$message (last answer: HTTP $code)"
    # /readyz names the dependency that is down in its body.
    local excerpt
    excerpt="$(head -c 300 "$body" | tr '\r\n' '  ')"
    [ -z "$excerpt" ] || message="$message: $excerpt"
  fi
  fail "$step" "$message"
}

wait_for_200 "readyz" "http://127.0.0.1:${api_port}/readyz"
wait_for_200 "web" "http://127.0.0.1:${web_port}/"

echo "==> api smoke: python -m app.smoke in the api container"
"${COMPOSE_CMD[@]}" -f compose.yaml exec -T api python -m app.smoke "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
  # app.smoke names its failed step on one line; repeat it so the last thing
  # printed says which step failed (compose's own error is above it otherwise).
  detail="$(grep -m 1 '^smoke: FAILED' "$log" || true)"
  fail "api smoke" "python -m app.smoke exited with status $status${detail:+: $detail}"
fi
# Do not trust a zero status alone: a compose front end that loses the exit
# status of `exec` would turn a failed smoke into a pass.
if ! grep -q '^smoke: OK' "$log"; then
  fail "api smoke" "python -m app.smoke exited 0 but never reported success ('smoke: OK')"
fi

echo "stack-smoke: OK - readyz, web and api smoke all passed"
