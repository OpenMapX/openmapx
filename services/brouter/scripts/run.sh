#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=services/brouter/scripts/coverage.sh
source "$(dirname "$0")/coverage.sh"

ROOT=${BROUTER_DATA_DIR:-/data/brouter}
REGION=$(normalize_region "${REGION:-europe/germany}")

if [[ "${1:-}" == health ]]; then
  [[ -s "$ROOT/current/region" && $(cat "$ROOT/current/region") == "$REGION" ]]
  exec curl --fail --silent --max-time 4 http://127.0.0.1:17777/robots.txt -o /dev/null
fi

positive_integer() {
  local value="$1" max="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]{0,5}$ ]] || (( value > max )); then
    echo 'Invalid BRouter numeric configuration' >&2; exit 1
  fi
}
UPDATE_INTERVAL_HOURS=${UPDATE_INTERVAL_HOURS:-168}
JAVA_HEAP_MB=${JAVA_HEAP_MB:-1024}
MAXTHREADS=${MAXTHREADS:-2}
REQUEST_TIMEOUT_SECONDS=${REQUEST_TIMEOUT_SECONDS:-30}
positive_integer "$UPDATE_INTERVAL_HOURS" 8760
positive_integer "$JAVA_HEAP_MB" 65536
positive_integer "$MAXTHREADS" 32
positive_integer "$REQUEST_TIMEOUT_SECONDS" 300
(( JAVA_HEAP_MB >= 128 )) || exit 1

VERSION=1.7.10
DISTRIBUTION_SHA256=023fec3ba997758e8cd7ab9e1bae52e962af3f00b57683e3de86b84ffad01532
DIST="$ROOT/distribution-$VERSION"
engine_pid=
downloader_pid=
sleeper_pid=
transfer_pid=
shutdown() {
  trap - TERM INT
  for pid in "$downloader_pid" "$transfer_pid" "$engine_pid" "$sleeper_pid"; do
    [[ -z "$pid" ]] || kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT
mkdir -p "$ROOT"
# Interrupted transactions are never candidates for serving.
rm -rf "$ROOT"/.staging-* "$ROOT"/.distribution-*
if [[ ! -f "$DIST/.verified" ]]; then
  staging="$ROOT/.distribution-$$"
  mkdir -p "$staging"
  fetch_file "https://github.com/abrensch/brouter/releases/download/v$VERSION/brouter-$VERSION.zip" "$staging/release.zip" 10000000
  printf '%s  %s\n' "$DISTRIBUTION_SHA256" "$staging/release.zip" | sha256sum --check --status
  (cd "$staging" && jar xf release.zip "brouter-$VERSION/brouter-$VERSION-all.jar" "brouter-$VERSION/profiles2")
  mv "$staging/brouter-$VERSION" "$DIST"
  touch "$DIST/.verified"
  rm -rf "$staging"
fi

cleanup_generations() {
  local active old
  active=$(readlink "$ROOT/current" 2>/dev/null || true)
  for old in "$ROOT"/generation-*; do
    [[ "${old##*/}" == "$active" ]] || rm -rf "$old" || return 1
  done
}
cleanup_generations

prepare() {
  cleanup_generations || return 1
  bash "$(dirname "$0")/coverage.sh" "$ROOT" "$REGION" \
    https://brouter.de/brouter/segments4/ \
    https://brouter.de/brouter/profiles2/lookups.dat > "$ROOT/prepared" &
  downloader_pid=$!
  local status=0
  wait "$downloader_pid" || status=$?
  downloader_pid=
  (( status == 0 )) || return "$status"
  candidate=$(cat "$ROOT/prepared") || return 1
  if ! cp "$DIST"/profiles2/*.brf "$candidate/profiles2/" ||
     ! java -Xmx256m -cp "$DIST/brouter-$VERSION-all.jar" \
       "$(dirname "$0")/ValidateProfiles.java" "$candidate/profiles2"; then
    cleanup_generations
    return 1
  fi
  printf '%s\n' "$VERSION" > "$candidate/engine-version"
}
stop_engine() {
  if [[ -n "$engine_pid" ]]; then
    kill "$engine_pid" 2>/dev/null || true
    wait "$engine_pid" 2>/dev/null || true
    engine_pid=
  fi
}
start_engine() {
  local active
  active=$(readlink "$ROOT/current")
  mkdir -p "$ROOT/customprofiles"
  # BRouter logs complete request URLs to stdout; keep route coordinates out
  # of persistent service logs. JVM startup errors still reach stderr.
  java "-Xmx${JAVA_HEAP_MB}M" -Xms128M "-DmaxRunningTime=$REQUEST_TIMEOUT_SECONDS" \
    -DuseRFCMimeType=true -cp "$DIST/brouter-$VERSION-all.jar" \
    btools.server.RouteServer "$ROOT/$active/segments4" "$ROOT/$active/profiles2" \
    "$ROOT/customprofiles" 17777 "$MAXTHREADS" 0.0.0.0 > /dev/null &
  engine_pid=$!
  echo "BRouter $VERSION started for $REGION ($active)"
}
activate() {
  stop_engine
  publish_generation "$ROOT" "$candidate"
  start_engine
  for old in "$ROOT"/generation-*; do
    [[ "$old" == "$candidate" ]] || rm -rf "$old"
  done
}
if [[ ! -s "$ROOT/current/region" || $(cat "$ROOT/current/region") != "$REGION" || \
      ! -s "$ROOT/current/engine-version" || $(cat "$ROOT/current/engine-version") != "$VERSION" ]]; then
  prepare
  activate
else
  start_engine
fi

next_refresh=$(( $(cat "$ROOT/current/updated-at") + UPDATE_INTERVAL_HOURS * 3600 ))
while true; do
  sleep 30 &
  sleeper_pid=$!
  wait "$sleeper_pid"
  sleeper_pid=
  if ! kill -0 "$engine_pid" 2>/dev/null; then
    echo 'BRouter process exited unexpectedly' >&2
    wait "$engine_pid" || exit $?
    exit 1
  fi
  if (( $(date +%s) >= next_refresh )); then
    if prepare; then
      activate
      next_refresh=$(( $(date +%s) + UPDATE_INTERVAL_HOURS * 3600 ))
    else
      echo 'BRouter refresh failed; retaining the current generation and retrying in one hour' >&2
      next_refresh=$(( $(date +%s) + 3600 ))
    fi
  fi
done
