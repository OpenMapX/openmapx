#!/usr/bin/env bash
# OpenMapX postgis entrypoint wrapper.
#
# Postgres only consumes POSTGRES_PASSWORD on first init: once the volume has
# a populated data dir, the password baked into pg_authid is authoritative
# and any change to POSTGRES_PASSWORD in `.env` silently does nothing. That's
# a sharp footgun — operators rotate the secret, restart the stack, and
# app-api auth fails with no obvious cause.
#
# This wrapper runs the upstream postgres entrypoint in the background, waits
# for it to accept connections via the local Unix-socket trust rule, and
# rewrites the superuser password from the env on every start. The ALTER is
# idempotent in effect: matching passwords produce a small WAL write and no
# observable change.
set -euo pipefail

# Diagnostics are opt-in. Validate before starting the server, never echo values.
DIAGNOSTICS=false
case "${PG_STAT_STATEMENTS:-false}" in
  true|1) DIAGNOSTICS=true ;;
  false|0|"") ;;
  *) echo "[openmapx-postgis] PG_STAT_STATEMENTS must be true or false" >&2; exit 1 ;;
esac
if [ "$DIAGNOSTICS" = true ]; then
  if [ "${1:-}" != postgres ]; then
    echo "[openmapx-postgis] diagnostics require the postgres startup command" >&2; exit 1
  fi
  for arg in "$@"; do
    case "$arg" in
      *shared_preload_libraries*|*config_file*|*data_directory*|-D*|--data-directory*)
        echo "[openmapx-postgis] diagnostics conflict with custom preload/configuration arguments" >&2; exit 1 ;;
    esac
  done
  # Respect existing configuration, including include files and ALTER SYSTEM.
  # The stock image starts as root and switches to postgres via gosu.
  if [ -f "${PGDATA:-/var/lib/postgresql/18/docker}/PG_VERSION" ] || [ -f "${PGDATA:-/var/lib/postgresql/18/docker}/postgresql.conf" ]; then
    config_args=("${@:2}")
    if [ "$(id -u)" = 0 ]; then
      PRELOAD=$(gosu postgres postgres -D "$PGDATA" "${config_args[@]}" -C shared_preload_libraries)
    else
      PRELOAD=$(postgres -D "$PGDATA" "${config_args[@]}" -C shared_preload_libraries)
    fi
    if [ -n "$PRELOAD" ] && [ "$PRELOAD" != pg_stat_statements ]; then
      echo "[openmapx-postgis] diagnostics conflict with existing preload libraries" >&2; exit 1
    fi
  fi
  set -- "$@" -c shared_preload_libraries=pg_stat_statements -c compute_query_id=auto \
    -c pg_stat_statements.track=top -c pg_stat_statements.track_utility=off \
    -c pg_stat_statements.save=off
fi

PG_USER="${POSTGRES_USER:-postgres}"
# Sentinel file the healthcheck looks for. Postgres starts accepting TCP
# connections a moment before the ALTER USER below runs, so without this
# gate dependent containers (app-api) can race in, hit the still-stale
# password, and crash-loop until they retry past the window. The sentinel
# is recreated on every container start so a stale one from a previous
# instance doesn't fool the healthcheck.
SYNC_SENTINEL="/var/run/postgresql/openmapx-password-synced"
rm -f "$SYNC_SENTINEL"

# Forward SIGTERM/SIGINT to postgres so it gets a clean shutdown
# (`docker stop`, compose down, host signals).
forward_signal() {
  local sig="$1"
  if [ -n "${PG_PID:-}" ] && kill -0 "$PG_PID" 2>/dev/null; then
    kill "-$sig" "$PG_PID" 2>/dev/null || true
  fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT'  INT
cleanup() {
  local status=$?
  if [ -n "${PG_PID:-}" ] && kill -0 "$PG_PID" 2>/dev/null; then
    kill -TERM "$PG_PID" 2>/dev/null || true
    wait "$PG_PID" 2>/dev/null || true
  fi
  rm -f "$SYNC_SENTINEL"
  return "$status"
}
trap cleanup EXIT

# Background-start the upstream entrypoint with whatever args compose passed
# (typically `postgres`).
docker-entrypoint.sh "$@" &
PG_PID=$!

# Wait for postgres to accept connections, but bail if it crashes first.
# The upstream initialization server listens on Unix sockets only. Wait for
# TCP so password sync and readiness cannot race its shutdown/restart.
until pg_isready -U "$PG_USER" -d postgres -h 127.0.0.1 -q 2>/dev/null; do
  if ! kill -0 "$PG_PID" 2>/dev/null; then
    echo "[openmapx-postgis] postgres exited before becoming ready" >&2
    wait "$PG_PID" || true
    exit 1
  fi
  sleep 1
done

# Resync the superuser password from env. Embedded single quotes (the only
# character that can break out of a SQL string literal in standard-conforming
# mode) are doubled before interpolation. `log_statement=none` keeps the
# ALTER off the postgres logs so the password doesn't land there in
# plaintext.
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  ESCAPED_PASSWORD=${POSTGRES_PASSWORD//\'/\'\'}
  PGOPTIONS="-c log_statement=none" \
    psql -U "$PG_USER" -d postgres -h /var/run/postgresql \
      -v ON_ERROR_STOP=1 --no-psqlrc -q \
      -c "ALTER USER \"${PG_USER}\" WITH PASSWORD '${ESCAPED_PASSWORD}';" >/dev/null
  echo "[openmapx-postgis] superuser password synced from env"
fi

if [ "$DIAGNOSTICS" = true ]; then
  PGOPTIONS="-c log_statement=none -c statement_timeout=10000" \
    psql -U "$PG_USER" -d "${POSTGRES_DB:-$PG_USER}" -h /var/run/postgresql \
      -v ON_ERROR_STOP=1 --no-psqlrc -q \
      -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null
  echo "[openmapx-postgis] diagnostics ready"
fi

# Mark the sync as done. Healthcheck only returns success after this exists,
# so dependents waiting on `condition: service_healthy` start with a known-
# good password baseline.
touch "$SYNC_SENTINEL"

# Hand control back to postgres in the foreground; container exit code
# matches postgres'.
wait "$PG_PID"
