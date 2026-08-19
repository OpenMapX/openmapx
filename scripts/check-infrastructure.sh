#!/usr/bin/env bash
set -euo pipefail

readonly ACTIONLINT_IMAGE="rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667" # v1.7.12
readonly SHELLCHECK_IMAGE="koalaman/shellcheck@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d" # v0.11.0
readonly HADOLINT_IMAGE="hadolint/hadolint@sha256:9a3944b7fddcb947d1ffd90829ac1a6e5c30479223358f249d8b96c7d0019e27" # v2.15.1-debian

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
cd "$REPO_ROOT"

docker run --rm -v "$REPO_ROOT:/repo" -w /repo "$ACTIONLINT_IMAGE" -color

docker run --rm -v "$REPO_ROOT:/repo" -w /repo "$SHELLCHECK_IMAGE" \
  apps/web/docker-entrypoint.sh \
  scripts/check-infrastructure.sh \
  services/dawarich-app/scripts/openmapx-entrypoint.sh \
  services/dawarich-sidekiq/scripts/openmapx-entrypoint.sh \
  services/motis/tools/transitous/run.sh \
  services/postgis/scripts/sync-password.sh

docker run --rm -v "$REPO_ROOT:/repo" -w /repo "$HADOLINT_IMAGE" /bin/hadolint \
  apps/api/Dockerfile \
  apps/web/Dockerfile \
  docs/Dockerfile \
  services/data-manager/Dockerfile \
  services/motis/tools/transitous/Dockerfile
