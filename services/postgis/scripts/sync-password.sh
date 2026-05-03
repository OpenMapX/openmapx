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

PG_USER="${POSTGRES_USER:-postgres}"

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

# Background-start the upstream entrypoint with whatever args compose passed
# (typically `postgres`).
docker-entrypoint.sh "$@" &
PG_PID=$!

# Wait for postgres to accept connections, but bail if it crashes first.
until pg_isready -U "$PG_USER" -d postgres -h /var/run/postgresql -q 2>/dev/null; do
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

# Hand control back to postgres in the foreground; container exit code
# matches postgres'.
wait "$PG_PID"
