#!/usr/bin/env bash
#
# Check every OpenTofu configuration under infra/ without cloud credentials.
#
#   npm run infra:check
#
# Runs `tofu fmt -check -recursive infra`, then for every directory holding
# .tf files runs `tofu init -backend=false` and `tofu validate`. Init is given
# -backend=false, so it never contacts a state bucket and needs no cloud
# credentials; it only downloads the pinned providers. The script exits
# non-zero if any of those commands fails.
#
# Generated artifacts (.terraform/, .terraform.lock.hcl) are removed again so a
# check leaves the working tree exactly as it found it.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

if ! command -v tofu >/dev/null 2>&1; then
  echo "infra-check: OpenTofu ('tofu') is not installed." >&2
  echo "infra-check: install it from https://opentofu.org/docs/intro/install/" >&2
  exit 127
fi

# Deterministic, non-interactive output in CI and locally.
export TF_IN_AUTOMATION=1

status=0

echo "==> tofu fmt -check -recursive infra"
if ! tofu fmt -check -recursive infra; then
  echo "infra-check: files are not formatted; run 'tofu fmt -recursive infra'." >&2
  status=1
fi

# Every directory with at least one .tf file: the modules and each environment.
config_dirs=()
while IFS= read -r dir; do
  config_dirs+=("$dir")
done < <(find infra -type f -name '*.tf' -exec dirname {} \; | sort -u)

cleanup() {
  local dir="$1"
  local had_data="$2"
  local had_lock="$3"
  local tmp_dir="$4"

  if [ "$had_data" -eq 0 ]; then
    rm -rf "$dir/.terraform"
  fi
  if [ "$had_lock" -eq 0 ]; then
    rm -f "$dir/.terraform.lock.hcl"
  fi
  rm -rf "$dir/$tmp_dir"
}

for dir in "${config_dirs[@]}"; do
  echo "==> $dir: tofu init -backend=false"

  had_data=0
  had_lock=0
  [ -d "$dir/.terraform" ] && had_data=1
  [ -f "$dir/.terraform.lock.hcl" ] && had_lock=1

  if ! init_output="$(cd "$dir" && tofu init -backend=false -input=false -no-color 2>&1)"; then
    echo "$init_output"
    echo "infra-check: init failed in $dir" >&2
    status=1
    cleanup "$dir" "$had_data" "$had_lock" ".tofu-tmp-$$"
    continue
  fi

  # OpenTofu hands provider plugin sockets to the OS through $TMPDIR, and Unix
  # socket paths are limited to roughly 108 characters. A relative $TMPDIR
  # keeps the path short even when the checkout lives under a long directory.
  tmp_dir=".tofu-tmp-$$"
  mkdir -p "$dir/$tmp_dir"

  echo "==> $dir: tofu validate"
  if ! validate_output="$(cd "$dir" && TMPDIR="$tmp_dir" tofu validate -no-color 2>&1)"; then
    echo "$validate_output"
    echo "infra-check: validate failed in $dir" >&2
    status=1
  else
    echo "    ok"
  fi

  cleanup "$dir" "$had_data" "$had_lock" "$tmp_dir"
done

if [ "$status" -ne 0 ]; then
  echo "infra-check: FAILED" >&2
  exit "$status"
fi

echo "infra-check: all OpenTofu configurations are formatted and valid"
