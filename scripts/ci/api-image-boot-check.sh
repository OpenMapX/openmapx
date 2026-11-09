#!/usr/bin/env bash
# Starts a built API image against disposable PostGIS and Valkey on a private
# Docker network and requires GET /api/status to report a ready API.
#
#   scripts/ci/api-image-boot-check.sh [image]
#
# API_BOOT_TIMEOUT_SECONDS bounds the wait for the API. API_BOOT_OMIT_SETTING
# names one setting to leave out, which shows the check fails when the API
# cannot boot.
set -euo pipefail

image="${1:-openmapx-ci:api}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
timeout_seconds="${API_BOOT_TIMEOUT_SECONDS:-240}"
omit_setting="${API_BOOT_OMIT_SETTING:-}"
run_id="openmapx-api-boot-$$"
network="$run_id"
postgis="$run_id-postgis"
valkey="$run_id-valkey"
api="$run_id-api"
secrets="$(mktemp -d)"

cleanup() {
  docker rm --force "$api" "$valkey" "$postgis" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$secrets"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "API image boot check failed: $1" >&2
  if docker container inspect "$api" >/dev/null 2>&1; then
    echo "--- API container logs ---" >&2
    docker logs "$api" >&2 || true
  fi
  exit 1
}

pinned_image() {
  node -e '
    const { container: c } = require(process.argv[1]);
    console.log(`${c.image}:${c.tag}@${c.digest}`);
  ' "$root/services/$1/service.json"
}

docker image inspect "$image" >/dev/null 2>&1 || fail "image $image is not available locally"

postgres_password="$(openssl rand -hex 32)"
redis_password="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
printf '%s' "$redis_password" >"$secrets/redis-password"
chmod 755 "$secrets"
chmod 644 "$secrets/redis-password"

docker network create --internal "$network" >/dev/null

docker run --detach --name "$postgis" --network "$network" --network-alias postgis \
  --env POSTGRES_PASSWORD="$postgres_password" \
  --env POSTGRES_DB=openmapx \
  "$(pinned_image postgis)" >/dev/null

docker run --detach --name "$valkey" --network "$network" --network-alias redis \
  "$(pinned_image redis)" --requirepass "$redis_password" >/dev/null

# Probe over TCP: during first-run initialization the image's temporary server
# answers only on the Unix socket and is then restarted.
deadline=$((SECONDS + timeout_seconds))
until docker exec "$postgis" pg_isready --host 127.0.0.1 --username postgres --dbname openmapx >/dev/null 2>&1; do
  ((SECONDS < deadline)) || fail "PostGIS did not become ready within ${timeout_seconds}s"
  sleep 1
done

settings=(
  "DATABASE_URL=postgresql://postgres:$postgres_password@postgis:5432/openmapx"
  "REDIS_URL=redis://redis:6379"
  "REDIS_PASSWORD_FILE=/run/secrets/redis-password"
  "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
  "BETTER_AUTH_URL=https://localhost"
  "CORS_ORIGIN=https://localhost"
  "OPENMAPX_SECRETS_KEY=$(openssl rand -hex 32)"
  "HOST=0.0.0.0"
  "PORT=3001"
)
environment=()
for setting in "${settings[@]}"; do
  [[ "${setting%%=*}" == "$omit_setting" ]] && continue
  environment+=(--env "$setting")
done

docker run --detach --name "$api" --network "$network" \
  --volume "$secrets/redis-password:/run/secrets/redis-password:ro" \
  "${environment[@]}" \
  "$image" >/dev/null

# Status is a process-wide snapshot: 200 with unavailable=false means a probe
# has completed. Both platform dependencies must be up, since a boot that
# cannot reach either one is not a working API.
probe='
  fetch("http://127.0.0.1:3001/api/status", { signal: AbortSignal.timeout(10000) })
    .then(async (response) => {
      const body = await response.json();
      const up = (id) => body.services?.some((s) => s.id === id && s.status === "up");
      process.exit(response.status === 200 && body.unavailable === false && up("postgresql") && up("redis") ? 0 : 1);
    })
    .catch(() => process.exit(1));
'

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
  state="$(docker inspect --format '{{.State.Status}}' "$api")"
  if [[ "$state" != "running" ]]; then
    fail "the API container stopped ($state, exit code $(docker inspect --format '{{.State.ExitCode}}' "$api"))"
  fi
  if docker exec "$api" node -e "$probe" >/dev/null 2>&1; then
    echo "API image boot check passed: $image reported ready after ${SECONDS}s"
    exit 0
  fi
  sleep 3
done

fail "/api/status did not report ready within ${timeout_seconds}s"
