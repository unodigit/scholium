#!/bin/sh
#
# One-shot job for the minio-init service in compose.yaml: make sure the bucket
# the API and worker use exists, then exit. Safe to run any number of times; a
# bucket that is already there is left alone, objects included.
#
# It runs inside the MinIO image, which carries the `mc` client, so it is POSIX
# sh and needs nothing else. Settings come from the service's environment:
#
#   MINIO_ENDPOINT        where MinIO listens          (http://minio:9000)
#   MINIO_ROOT_USER       the MinIO administrator
#   MINIO_ROOT_PASSWORD
#   S3_BUCKET             the bucket to create
#
# Exit status: 0 once the bucket exists, 1 when MinIO cannot be reached with
# those credentials or the bucket cannot be created, 2 for a missing setting.
# compose starts the API after this has exited; a bucket that is missing shows
# up as GET /readyz answering 503 for the object store.

set -eu

for name in MINIO_ENDPOINT MINIO_ROOT_USER MINIO_ROOT_PASSWORD S3_BUCKET; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "minio-init: $name is not set" >&2
    exit 2
  fi
done

# The client keeps its alias configuration in a directory it can write.
export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/.mc}"

# The client is `mc`; some builds install it as `mcli` because mc is also the
# name of Midnight Commander.
if command -v mc >/dev/null 2>&1; then
  MC=mc
elif command -v mcli >/dev/null 2>&1; then
  MC=mcli
else
  echo "minio-init: neither mc nor mcli is in this image; set MINIO_IMAGE to one that has it" >&2
  exit 1
fi

# compose starts this job once MinIO reports healthy, but a start that races the
# server (or a compose that does not wait) is retried instead of failing the stack.
attempts=30
attempt=1
until output="$("$MC" alias set stack "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" 2>&1)"; do
  if [ "$attempt" -ge "$attempts" ]; then
    echo "minio-init: cannot reach MinIO at $MINIO_ENDPOINT after $attempts attempts:" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "minio-init: MinIO is not answering yet (attempt $attempt of $attempts)"
  attempt=$((attempt + 1))
  sleep 2
done

# --ignore-existing makes this a no-op on every run after the first. A new
# bucket is private: nothing here grants anonymous access.
"$MC" mb --ignore-existing "stack/$S3_BUCKET"

echo "minio-init: bucket $S3_BUCKET is ready at $MINIO_ENDPOINT"
