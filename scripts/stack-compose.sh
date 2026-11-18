#!/usr/bin/env bash
#
# Run the local stack's compose command through one engine selector.
#
#   scripts/stack-compose.sh up -d --build
#   scripts/stack-compose.sh exec -T api python -m app.smoke
#
# Every stack:* npm script (and scripts/stack-smoke.sh) calls this script with
# the compose arguments; compose.yaml is supplied here, so callers only name the
# command (up, down, logs, exec, ...) and its options.
#
# The engine is chosen as before: STACK_COMPOSE when set, else podman-compose
# when it is installed, else `docker compose`.
#
# podman-compose must be 1.6.0 or newer.  This script reads the version from
# `podman-compose --version` and refuses an older one with exit status 1: this
# compose.yaml uses nested ${A:-${B}} variable defaults and COMPOSE_PROFILES,
# which podman-compose only understands from 1.6.0.  The refusal says which
# version is installed and what to do about it.  A docker-compose engine is not
# version-checked.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

MIN_PODMAN_COMPOSE="1.6.0"

compose_cmd=()
if [ -n "${STACK_COMPOSE:-}" ]; then
  read -r -a compose_cmd <<< "$STACK_COMPOSE"
elif command -v podman-compose >/dev/null 2>&1; then
  compose_cmd=(podman-compose)
elif docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
else
  echo "stack-compose: podman-compose or 'docker compose' is required (or set STACK_COMPOSE)" >&2
  exit 127
fi

# podman-compose, however it was chosen (an absolute path in STACK_COMPOSE
# included), is held to the version floor.
engine="${compose_cmd[0]##*/}"
if [ "$engine" = "podman-compose" ]; then
  version_output="$("${compose_cmd[0]}" --version 2>&1)" || true
  # The first X.Y.Z in the output; the surrounding words differ by release.
  version="$(printf '%s\n' "$version_output" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
  if [ -z "$version" ]; then
    echo "stack-compose: cannot tell which podman-compose this is: '${compose_cmd[0]} --version' printed no X.Y.Z version" >&2
    echo "compose.yaml needs podman-compose ${MIN_PODMAN_COMPOSE} or newer; upgrade with 'pipx install podman-compose', or use docker compose: STACK_COMPOSE=\"docker compose\"" >&2
    exit 1
  fi
  IFS=. read -r version_major version_minor version_patch <<< "$version"
  if [ "$version_major" -lt 1 ] || { [ "$version_major" -eq 1 ] && [ "$version_minor" -lt 6 ]; }; then
    {
      printf 'stack-compose: podman-compose %s is older than %s.\n' "$version" "$MIN_PODMAN_COMPOSE"
      printf 'compose.yaml needs podman-compose %s or newer: its nested ${A:-${B}} variable defaults and COMPOSE_PROFILES are only understood from 1.6.0.\n' "$MIN_PODMAN_COMPOSE"
      printf 'Upgrade with `pipx install podman-compose`, or use docker compose: STACK_COMPOSE="docker compose"\n'
    } >&2
    exit 1
  fi
fi

exec "${compose_cmd[@]}" -f compose.yaml "$@"
