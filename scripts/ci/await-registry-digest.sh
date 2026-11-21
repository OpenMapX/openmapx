#!/usr/bin/env bash
# Wait until a registry tag resolves to the expected manifest digest.
#
# Usage: await-registry-digest.sh <ref> <expected-digest>
#
# Registries can serve the previous value of a tag for a short time after
# `docker buildx imagetools create` moved it, so a single read-back can fail
# although the tag moved correctly. Read until the digest matches; a failing
# read counts as stale. Fail with both digests after the last attempt.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <ref> <expected-digest>" >&2
  exit 2
fi

ref=$1
expected=$2
attempts=${AWAIT_REGISTRY_DIGEST_ATTEMPTS:-12}
delay=${AWAIT_REGISTRY_DIGEST_DELAY_SECONDS:-5}
seen="(no answer)"

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if published=$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null); then
    seen=$published
    if [ "$published" = "$expected" ]; then
      exit 0
    fi
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    sleep "$delay"
  fi
done

echo "Published digest mismatch for ${ref}: expected ${expected}, got ${seen} after ${attempts} reads" >&2
exit 1
