#!/usr/bin/env bash
#
# Start the local stack in dependency stages (npm run stack:up, npm run stack:deps).
#
#   npm run stack:up      all three stages: backing services, bucket job, application
#   npm run stack:deps    the first two only: db, minio, mailpit and minio-init
#   scripts/stack-up-staged.sh [--deps-only]
#
# The stages, in order; every compose command runs through scripts/stack-compose.sh:
#
#   1. up -d --no-deps db minio mailpit
#                 then poll `ps` until each of the three reports (healthy);
#   2. up -d --no-deps minio-init
#                 then poll `ps` until it has exited with status 0 (the bucket exists);
#   3. up -d --no-deps --build --remove-orphans api worker web       (stack:up only)
#                 plus sandbox when COMPOSE_PROFILES (environment or .env) enables it.
#
# Why not one `up -d`, with the depends_on of compose.yaml ordering it: podman-compose
# 1.6 creates each container with --requires for every depends_on entry, and podman
# 4.9 then refuses to start api or worker once the one-shot minio-init has exited
# ("generating dependency graph ... not found in input list"). So this script never
# relies on depends_on: every stage passes --no-deps and the script itself waits for
# what the next stage needs. depends_on stays in compose.yaml for plain
# `docker compose up` and for the deployments that run the file as it is.
#
# Each wait gives up after STACK_UP_TIMEOUT seconds (default 300) with exit status 1
# and a message naming the service and the last status `ps` showed for it. A
# minio-init that exited with a status other than 0 fails at once: it does not run
# again, so waiting longer cannot help. A failing compose command ends the script
# with that command's exit status. STACK_UP_POLL_INTERVAL (default 2) is the number
# of seconds between two `ps` calls; it may be fractional.
#
# The status is read from the plain table `ps` prints (podman-compose and docker
# compose alike): the row naming the service, then its STATUS text, for example
# "Up 12 seconds (healthy)" or "Exited (0) 3 seconds ago". docker compose lists an
# exited container only with -a, so minio-init is looked up with `ps -a` when plain
# `ps` does not show it.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

usage() {
  echo "usage: scripts/stack-up-staged.sh [--deps-only]" >&2
}

mode=up
case "${1:-}" in
  '') ;;
  --deps-only) mode=deps ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "stack-up-staged: unknown argument '$1'" >&2
    usage
    exit 2
    ;;
esac
if [ "$#" -gt 1 ]; then
  echo "stack-up-staged: unexpected argument '$2'" >&2
  usage
  exit 2
fi

timeout="${STACK_UP_TIMEOUT:-300}"
case "$timeout" in
  '' | *[!0-9]* | 0)
    echo "stack-up-staged: STACK_UP_TIMEOUT must be a whole number of seconds, not '$timeout'" >&2
    exit 2
    ;;
esac

interval="${STACK_UP_POLL_INTERVAL:-2}"
# A positive number: digits with at most one dot, and at least one non-zero digit.
case "$interval" in
  '' | *[!0-9.]* | *.*.*) interval_ok=0 ;;
  *[1-9]*) interval_ok=1 ;;
  *) interval_ok=0 ;;
esac
if [ "$interval_ok" -ne 1 ]; then
  echo "stack-up-staged: STACK_UP_POLL_INTERVAL must be a positive number of seconds, not '$interval'" >&2
  exit 2
fi
interval_whole="${interval%%.*}"
interval_whole="${interval_whole:-0}"

compose() { # compose ARGS...: the engine selector, with its podman-compose version floor
  bash "$root/scripts/stack-compose.sh" "$@"
}

# The value of a setting the way compose resolves it: the environment first, then
# .env next to compose.yaml, then the default (the same rule as stack-smoke.sh).
setting() { # setting NAME DEFAULT
  local name=$1 default=$2 value="${!1:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=[[:space:]]*//p" .env | tail -n 1)"
    value="${value#[\"\']}"
    value="${value%%[[:space:]#\"\']*}"
  fi
  printf '%s' "${value:-$default}"
}

err="$(mktemp)"
trap 'rm -f "$err"' EXIT

# The STATUS text of the container of SERVICE in the `ps` table on stdin; nothing
# when the table has no such container. A container is the row with a word that is
# the service name (docker compose's SERVICE column) or ends in it as
# <project>_<service>_<n> or <project>-<service>-<n> (its name).
status_in_table() { # status_in_table SERVICE < table
  local service=$1 line word
  local -a words
  local keywords='Up|Exited|Created|Paused|Restarting|Removing|Dead'
  while IFS= read -r line; do
    read -r -a words <<< "$line"
    for word in "${words[@]+"${words[@]}"}"; do
      if [[ $word == "$service" || $word =~ ^(.*[_-])?${service}[_-][0-9]+$ ]]; then
        # From the status word to the first gap of two spaces (the next column).
        if [[ $line =~ (^|[[:space:]])(($keywords)( [^[:space:]]+)*) ]]; then
          printf '%s\n' "${BASH_REMATCH[2]}"
        else
          printf '%s\n' "$line" | tr -s '[:space:]' ' '
        fi
        return 0
      fi
    done
  done
  return 0
}

# Print the status of SERVICE now. Sets ps_failed when the engine's ps command fails.
current_status() { # current_status SERVICE [-a]
  local service=$1 all=${2:-} table status
  if ! table="$(compose ps 2>"$err")"; then
    status="ps failed: $(head -n 1 "$err")"
    printf '%s\n' "$status"
    return 0
  fi
  status="$(printf '%s\n' "$table" | status_in_table "$service")"
  if [ -z "$status" ] && [ -n "$all" ]; then
    # docker compose hides an exited container from plain ps; podman-compose has
    # no -a option and lists every container, so a failure here is ignored.
    if table="$(compose ps -a 2>/dev/null)"; then
      status="$(printf '%s\n' "$table" | status_in_table "$service")"
    fi
  fi
  printf '%s\n' "${status:-not listed by ps}"
}

# Wait until SERVICE meets CONDITION (healthy: its status says (healthy); exited:
# it has exited with status 0), for at most STACK_UP_TIMEOUT seconds.
wait_for() { # wait_for SERVICE healthy|exited
  local service=$1 condition=$2 status="" deadline remaining nap lookup=""
  [ "$condition" = exited ] && lookup=-a
  case "$condition" in
    healthy) echo "stack-up-staged: waiting for $service to be healthy (up to ${timeout}s)" ;;
    exited) echo "stack-up-staged: waiting for $service to exit with status 0 (up to ${timeout}s)" ;;
  esac
  deadline=$((SECONDS + timeout))
  while :; do
    status="$(current_status "$service" $lookup)"
    case "$condition" in
      healthy)
        if [[ $status == *"(healthy)"* ]]; then
          echo "stack-up-staged: $service is healthy"
          return 0
        fi
        ;;
      exited)
        if [[ $status =~ ^Exited\ \(0\) ]]; then
          echo "stack-up-staged: $service exited with status 0"
          return 0
        fi
        if [[ $status =~ ^Exited\ \([0-9]+\) ]]; then
          echo "stack-up-staged: FAILED: $service exited with a non-zero status; last status: $status" >&2
          echo "stack-up-staged: see its output with: npm run stack:logs -- $service" >&2
          exit 1
        fi
        ;;
    esac
    remaining=$((deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then
      case "$condition" in
        healthy) echo "stack-up-staged: FAILED: $service was not healthy after ${timeout}s; last status: $status" >&2 ;;
        exited) echo "stack-up-staged: FAILED: $service had not exited with status 0 after ${timeout}s; last status: $status" >&2 ;;
      esac
      echo "stack-up-staged: see its output with: npm run stack:logs -- $service" >&2
      exit 1
    fi
    nap=$interval
    if [ "$remaining" -lt "$interval_whole" ]; then
      nap=$remaining
    fi
    sleep "$nap"
  done
}

# Run a compose command, or end the script with its exit status.
run_stage() { # run_stage DESCRIPTION COMPOSE-ARGS...
  local description=$1 code
  shift
  echo "stack-up-staged: $description"
  compose "$@"
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "stack-up-staged: FAILED: '$*' exited with status $code" >&2
    exit "$code"
  fi
}

# Stage 1: the services with a healthcheck that everything else needs.
run_stage "stage 1: starting db, minio and mailpit" up -d --no-deps db minio mailpit
for service in db minio mailpit; do
  wait_for "$service" healthy
done

# Stage 2: the bucket job, which exits when the bucket exists.
run_stage "stage 2: creating the bucket with minio-init" up -d --no-deps minio-init
wait_for minio-init exited

if [ "$mode" = deps ]; then
  echo "stack-up-staged: the backing services are up (api, worker and web are not started)"
  exit 0
fi

# Stage 3: the application. The sandbox joins it when its profile is enabled, as it
# did when one `up` started everything.
application=(api worker web)
profiles=",$(setting COMPOSE_PROFILES ''),"
profiles="${profiles// /}"
case "$profiles" in
  *,sandbox,* | *,\*,*) application+=(sandbox) ;;
esac
run_stage "stage 3: building and starting ${application[*]}" \
  up -d --no-deps --build --remove-orphans "${application[@]}"
echo "stack-up-staged: the stack is up; verify it with: npm run stack:smoke"
