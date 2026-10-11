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

# Size the buffer pool and the planner's cache estimate from the container's
# memory limit (POSTGIS_MEMORY): a quarter for shared buffers, three quarters
# for the cache estimate. Postgres's own defaults (128MB, 4GB) ignore the
# limit, and a buffer pool that small sends a busy database to disk for
# every page. Without a limit the defaults stand: the host is shared.
if [ "${1:-}" = "postgres" ]; then
  limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)
  host_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  if [[ "$limit" =~ ^[0-9]+$ ]] && [ $((limit / 1024)) -lt "$host_kb" ]; then
    mb=$((limit / 1024 / 1024))
    set -- "$@" -c "shared_buffers=$((mb / 4))MB" -c "effective_cache_size=$((mb * 3 / 4))MB"
  fi
fi

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

# Run the SQL on stdin in one transaction. On a first start the upstream
# entrypoint initialises through a temporary server, which can answer before
# it has created the database and stops while it is used; every statement
# here is idempotent, so try again until the server that stays answers.
# `log_statement=none` keeps passwords off the postgres logs.
run_sql() {
  local db="$1" sql
  sql=$(cat)
  for _ in $(seq 30); do
    if PGOPTIONS="-c log_statement=none" \
      psql -U "$PG_USER" -d "$db" -h /var/run/postgresql \
        -v ON_ERROR_STOP=1 --no-psqlrc -q --single-transaction \
        >/dev/null 2>&1 <<<"$sql"; then
      return 0
    fi
    kill -0 "$PG_PID" 2>/dev/null || break
    sleep 1
  done
  PGOPTIONS="-c log_statement=none" \
    psql -U "$PG_USER" -d "$db" -h /var/run/postgresql \
      -v ON_ERROR_STOP=1 --no-psqlrc -q --single-transaction >/dev/null <<<"$sql"
}

# Resync the superuser password from env. Embedded single quotes (the only
# character that can break out of a SQL string literal in standard-conforming
# mode) are doubled before interpolation.
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  ESCAPED_PASSWORD=${POSTGRES_PASSWORD//\'/\'\'}
  run_sql postgres <<<"ALTER USER \"${PG_USER}\" WITH PASSWORD '${ESCAPED_PASSWORD}';"
  echo "[openmapx-postgis] superuser password synced from env"
fi

# The tile server's login. It may only call the functions in the `tiles`
# schema; each runs as its owner and returns one finished tile, so the role
# itself can read no table. The traffic-flow function looks up OpenConditions'
# `conditions.segment_flow` when called, so it can be created before
# OpenConditions is installed; that function calls PostGIS unqualified, hence
# `public` on the search path, which only the database owner may write to.
# Without MARTIN_DB_PASSWORD the role cannot log in.
TILES_ROLE="openmapx_tiles"
if [ -n "${MARTIN_DB_PASSWORD:-}" ]; then
  ESCAPED_TILES_PASSWORD=${MARTIN_DB_PASSWORD//\'/\'\'}
  TILES_LOGIN="LOGIN PASSWORD '${ESCAPED_TILES_PASSWORD}'"
else
  TILES_LOGIN="NOLOGIN PASSWORD NULL"
fi
run_sql "${POSTGRES_DB:-$PG_USER}" <<SQL
SELECT 'CREATE ROLE ${TILES_ROLE}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TILES_ROLE}')
\gexec
ALTER ROLE ${TILES_ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT ${TILES_LOGIN};
CREATE SCHEMA IF NOT EXISTS tiles;
REVOKE ALL ON SCHEMA tiles FROM PUBLIC;
GRANT USAGE ON SCHEMA tiles TO ${TILES_ROLE};
CREATE OR REPLACE FUNCTION tiles.segment_flow(z integer, x integer, y integer, query_params json)
  RETURNS bytea
  LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE SECURITY DEFINER
  SET search_path = public, pg_temp
AS \$\$
BEGIN
  RETURN conditions.segment_flow(z, x, y, query_params);
END;
\$\$;
REVOKE ALL ON FUNCTION tiles.segment_flow(integer, integer, integer, json) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tiles.segment_flow(integer, integer, integer, json) TO ${TILES_ROLE};
SQL
echo "[openmapx-postgis] tile server role ${TILES_ROLE} ready"

# Mark the sync as done. Healthcheck only returns success after this exists,
# so dependents waiting on `condition: service_healthy` start with a known-
# good password baseline.
touch "$SYNC_SENTINEL"

# Hand control back to postgres in the foreground; container exit code
# matches postgres'. A trapped signal ends `wait` at once, so wait again
# until postgres has finished its shutdown: exiting earlier ends the
# container, and Docker kills postgres before its shutdown checkpoint.
while kill -0 "$PG_PID" 2>/dev/null; do
  wait "$PG_PID" || true
done
wait "$PG_PID"
