#!/usr/bin/env bash
# run.sh — fengshui dev helper
# Usage: ./run.sh <command> [args...]
#
# Secret-bearing commands (wrapped in `op run` — Stripe / Anthropic /
# OpenAI / AWS / DB creds are present in process env):
#   ./run.sh forge   [args]     claw-forge with any args (default: no args)
#   ./run.sh state              start claw-forge state service (port 8420)
#   ./run.sh app                start FastAPI dev server (uvicorn --reload)
#   ./run.sh agent  "desc"      run claw-forge with a feature description
#   ./run.sh migrate [head]     run alembic upgrade (default: head)
#   ./run.sh worker             start the report generation worker (Dramatiq + asyncpg pool)
#   ./run.sh test   [args]      run pytest
#   ./run.sh shell              drop into a shell with secrets injected
#
# No-secret commands (run with a CLEAN env — package managers and linters
# must never see runtime credentials; this is the main supply-chain
# countermeasure for postinstall-style attacks):
#   ./run.sh install            uv sync (Python deps)
#   ./run.sh frontend-install   pnpm install --frozen-lockfile (in frontend/)
#   ./run.sh frontend-build     pnpm build (in frontend/)
#   ./run.sh lint               ruff check . && mypy .
#   ./run.sh frontend-lint      pnpm lint && pnpm type-check
#   ./run.sh sbom               generate SBOM + run osv-scanner

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_TPL="${SCRIPT_DIR}/.env.tpl"

cmd="${1:-help}"
shift || true

# ── Guards ────────────────────────────────────────────────────────────────────

# Only enforce 1Password / .env.tpl when the requested command needs secrets.
needs_secrets() {
  case "$1" in
    forge|state|agent|app|migrate|worker|test|shell) return 0 ;;
    *) return 1 ;;
  esac
}

if needs_secrets "${cmd}"; then
  if ! command -v op &>/dev/null; then
    echo "error: 1Password CLI (op) not found. Install via: brew install 1password-cli" >&2
    exit 1
  fi
  # Auto-load the 1Password service account token from a chmod-600 file when it
  # is not already in the environment, so secret-bearing commands work without a
  # manual `OP_SERVICE_ACCOUNT_TOKEN=... ` prefix (e.g. fresh shells / tmux panes).
  # Override the location with OP_TOKEN_FILE. Anything already in the env wins
  # (e.g. CI), and the token is exported only into this script's process tree.
  OP_TOKEN_FILE="${OP_TOKEN_FILE:-${HOME}/.config/op/token}"
  if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" && -r "${OP_TOKEN_FILE}" ]]; then
    export OP_SERVICE_ACCOUNT_TOKEN="$(<"${OP_TOKEN_FILE}")"
  fi
  if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    echo "error: OP_SERVICE_ACCOUNT_TOKEN not set and ${OP_TOKEN_FILE} not readable." >&2
    echo "       Create it (chmod 600) or export the token before running." >&2
    exit 1
  fi
  if [[ ! -f "${ENV_TPL}" ]]; then
    echo "error: ${ENV_TPL} not found." >&2
    exit 1
  fi
  if [[ -f "${SCRIPT_DIR}/.env" ]]; then
    echo "warning: plaintext .env file detected — remove it: rm ${SCRIPT_DIR}/.env" >&2
  fi
fi

# ── Wrapper ───────────────────────────────────────────────────────────────────

OP="op run --env-file=${ENV_TPL} --"

case "${cmd}" in

  # ── Secret-bearing commands ─────────────────────────────────────────────────

  forge)
    exec ${OP} claw-forge "$@"
    ;;

  state)
    echo "→ Starting claw-forge state service on port 8420..."
    exec ${OP} claw-forge state "$@"
    ;;

  agent)
    if [[ $# -eq 0 ]]; then
      echo "usage: ./run.sh agent \"feature description\"" >&2
      exit 1
    fi
    echo "→ Running agent: $*"
    exec ${OP} claw-forge run "$@"
    ;;

  app)
    echo "→ Starting FastAPI dev server (hot-reload on app/, engine/, main.py)..."
    exec ${OP} uv run uvicorn main:app \
      --reload \
      --reload-dir app \
      --reload-dir engine \
      --reload-include 'main.py' \
      --host 0.0.0.0 --port 8000 "$@"
    ;;

  migrate)
    target="${1:-head}"
    echo "→ Running alembic upgrade ${target}..."
    exec ${OP} uv run alembic upgrade "${target}"
    ;;

  worker)
    # CRITICAL: must invoke as `src.worker` (not `backend.src.worker`) from
    # cwd=backend/ with PYTHONPATH including the repo root.  Any other path
    # combination causes a silent double-import of `src.geo.engine` —
    # `configure_geo_pool()` writes to one module-globals copy,
    # `get_geo_pool()` reads None from another, and the GNAF address lookup
    # falls through to the Sydney-GPO stub (lat=-33.8688) instead of hitting
    # geo.addresses.  Symptom downstream: geo_fanout finds 0 roads → xuan_kong
    # raises OrchestratorPreconditionError("facing_direction absent in site_context").
    echo "→ Starting report-generation worker (cwd=backend/, module=src.worker)..."
    cd "${SCRIPT_DIR}/backend"
    exec ${OP} env PYTHONPATH="${SCRIPT_DIR}" uv run python -m src.worker "$@"
    ;;

  test)
    echo "→ Running tests..."
    exec ${OP} uv run pytest "$@"
    ;;

  shell)
    echo "→ Dropping into shell with secrets injected (type 'exit' to leave)..."
    exec ${OP} bash
    ;;

  # ── No-secret commands ──────────────────────────────────────────────────────
  # NEVER wrap these in `op run`. A compromised npm/pypi dep running during
  # install or lint must not see Stripe/Anthropic/OpenAI/AWS credentials.

  install)
    echo "→ uv sync (no secrets in env)..."
    exec uv sync "$@"
    ;;

  frontend-install)
    echo "→ pnpm install --frozen-lockfile in frontend/ (no secrets in env)..."
    cd "${SCRIPT_DIR}/frontend"
    exec pnpm install --frozen-lockfile "$@"
    ;;

  frontend-build)
    echo "→ pnpm build in frontend/ (no secrets in env)..."
    cd "${SCRIPT_DIR}/frontend"
    exec pnpm build "$@"
    ;;

  lint)
    echo "→ ruff + mypy (no secrets in env)..."
    uv run ruff check .
    exec uv run mypy .
    ;;

  frontend-lint)
    echo "→ pnpm lint + type-check in frontend/ (no secrets in env)..."
    cd "${SCRIPT_DIR}/frontend"
    pnpm lint
    exec pnpm type-check
    ;;

  sbom)
    echo "→ generating SBOM + scanning advisories (no secrets in env)..."
    cd "${SCRIPT_DIR}/frontend"
    pnpm audit || true
    pnpm dlx @cyclonedx/cyclonedx-npm --output-file "${SCRIPT_DIR}/frontend-sbom.json"
    pnpm dlx osv-scanner --lockfile=pnpm-lock.yaml
    ;;

  help|--help|-h)
    grep '^#' "${BASH_SOURCE[0]}" | grep -E '^\s*#\s+\.' | sed 's/^#//'
    ;;

  *)
    echo "error: unknown command '${cmd}'. Run ./run.sh help for usage." >&2
    exit 1
    ;;

esac
