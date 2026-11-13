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

SHUTDOWN_SIGNAL=""
WAIT_INTERRUPTED=0
PG_SIGNAL_FORWARDED=0

# Request graceful shutdown once, and cancel any initialization command.
# Subsequent signals still interrupt Bash's wait, but must not escalate postgres.
forward_signal() {
  local sig="$1"
  WAIT_INTERRUPTED=1
  if [ -z "$SHUTDOWN_SIGNAL" ]; then
    SHUTDOWN_SIGNAL="$sig"
  fi
  if [ "$PG_SIGNAL_FORWARDED" -eq 0 ] && [ -n "${PG_PID:-}" ]; then
    PG_SIGNAL_FORWARDED=1
    kill "-$SHUTDOWN_SIGNAL" "$PG_PID" 2>/dev/null || true
  fi
  if [ -n "${INIT_PID:-}" ]; then
    kill -TERM "$INIT_PID" 2>/dev/null || true
  fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT'  INT

# A trapped signal makes wait return 128 + signal before the child exits.
# Retry only interrupted waits; ordinary child exits 130/143 remain authoritative.
wait_for_child() {
  local pid="$1" status
  while true; do
    WAIT_INTERRUPTED=0
    if wait "$pid"; then
      status=0
    else
      status=$?
    fi
    if [ "$WAIT_INTERRUPTED" -eq 0 ]; then
      return "$status"
    fi
  done
}

finish_shutdown() {
  local status=0
  wait_for_child "$PG_PID" || status=$?
  exit "$status"
}

run_initialization_command() {
  local status=0
  if [ -n "$SHUTDOWN_SIGNAL" ]; then
    finish_shutdown
  fi
  "$@" <&0 &
  INIT_PID=$!
  if [ -n "$SHUTDOWN_SIGNAL" ]; then
    forward_signal "$SHUTDOWN_SIGNAL"
  fi
  wait_for_child "$INIT_PID" || status=$?
  unset INIT_PID
  if [ -n "$SHUTDOWN_SIGNAL" ]; then
    finish_shutdown
  fi
  return "$status"
}

# Size the buffer pool and the planner's cache estimate from the container's
# memory limit (POSTGIS_MEMORY): a quarter for shared buffers, three quarters
# for the cache estimate. Postgres's own defaults (128MB, 4GB) ignore the
# limit, and a buffer pool that small sends a busy database to disk for
# every page. Without a limit the defaults stand: the host is shared.
# POSTGIS_SHARED_BUFFERS replaces the quarter, for a write-heavy database
# whose changing pages outgrow it; POSTGIS_WORK_MEM sets the memory a sort
# or hash may use before it spills to temporary files.
for size in "${POSTGIS_SHARED_BUFFERS:-}" "${POSTGIS_WORK_MEM:-}"; do
  if [ -n "$size" ] && [[ ! "$size" =~ ^[1-9][0-9]*(kB|MB|GB)$ ]]; then
    echo "[openmapx-postgis] memory sizes must be a whole number of kB, MB or GB" >&2
    exit 1
  fi
done
if [ "${1:-}" = "postgres" ]; then
  limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)
  host_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  if [[ "$limit" =~ ^[0-9]+$ ]] && [ $((limit / 1024)) -lt "$host_kb" ]; then
    mb=$((limit / 1024 / 1024))
    set -- "$@" -c "shared_buffers=${POSTGIS_SHARED_BUFFERS:-$((mb / 4))MB}" -c "effective_cache_size=$((mb * 3 / 4))MB"
  elif [ -n "${POSTGIS_SHARED_BUFFERS:-}" ]; then
    set -- "$@" -c "shared_buffers=$POSTGIS_SHARED_BUFFERS"
  fi
  if [ -n "${POSTGIS_WORK_MEM:-}" ]; then
    set -- "$@" -c "work_mem=$POSTGIS_WORK_MEM"
  fi
fi

# Resolve the effective preload list through postgres itself, including command
# overrides and postgresql.auto.conf. Never guess on an uninitialized data dir.
for flag in "${POSTGIS_DIAGNOSTICS:-false}" "${POSTGIS_TRACK_IO_TIMING:-false}"; do
  case "$flag" in
    true|false) ;;
    *) echo "[openmapx-postgis] diagnostics flags must be true or false" >&2; exit 1 ;;
  esac
done
if [ "${1:-}" = "postgres" ]; then
  if [ "${POSTGIS_DIAGNOSTICS:-false}" = "true" ]; then
    if [ "$EUID" -eq 0 ]; then
      preload=$(gosu postgres "$@" -C shared_preload_libraries 2>/dev/null) || {
        echo "[openmapx-postgis] cannot resolve preloads; initialize database before diagnostics opt-in" >&2
        exit 1
      }
    else
      preload=$("$@" -C shared_preload_libraries 2>/dev/null) || {
        echo "[openmapx-postgis] cannot resolve preloads; initialize database before diagnostics opt-in" >&2
        exit 1
      }
    fi
    # Only unquoted comma-separated library names can be merged unambiguously.
    if [[ ! "$preload" =~ ^[[:space:]]*([a-zA-Z0-9_/$.-]+[[:space:]]*(,[[:space:]]*[a-zA-Z0-9_/$.-]+[[:space:]]*)*)?$ ]]; then
      echo "[openmapx-postgis] preload syntax cannot be safely merged" >&2
      exit 1
    fi
    preload=${preload//[[:space:]]/}
    case ",$preload," in
      *,pg_stat_statements,*) ;;
      *) preload="${preload:+$preload,}pg_stat_statements" ;;
    esac
    set -- "$@" -c "shared_preload_libraries=$preload" -c "pg_stat_statements.track_planning=off"
  fi
  if [ "${POSTGIS_TRACK_IO_TIMING:-false}" = "true" ]; then
    set -- "$@" -c "track_io_timing=on"
  fi
fi

# The API's and data-manager's own logins, so neither holds the superuser.
# The API owns the `public` schema and runs the migrations, which grant
# data-manager its own `data_manager` tables. The database itself stays the
# superuser's, so neither role can change settings that superuser sessions in
# it inherit. Data-manager may create schemas for the
# indexes it rebuilds; whatever it creates stays readable by the API. Both
# roles are cluster-wide, so they exist before a backup is restored into the
# database. `openmapx compose render` writes the two password files.
API_ROLE="openmapx_api"
DATA_MANAGER_ROLE="openmapx_data_manager"
read_password_file() {
  local value escaped
  if [ -z "${1:-}" ] || [ ! -f "$1" ] || ! value=$(<"$1") || [ -z "$value" ]; then
    echo "[openmapx-postgis] $2 password file is missing; run openmapx compose render" >&2
    return 1
  fi
  escaped=${value//\'/\'\'}
  printf '%s' "$escaped"
}
ESCAPED_API_PASSWORD=$(read_password_file "${OPENMAPX_API_DB_PASSWORD_FILE:-}" "API database") || exit 1
ESCAPED_DATA_MANAGER_PASSWORD=$(read_password_file "${OPENMAPX_DATA_MANAGER_DB_PASSWORD_FILE:-}" "data-manager database") || exit 1
if [ "$ESCAPED_API_PASSWORD" = "$ESCAPED_DATA_MANAGER_PASSWORD" ]; then
  echo "[openmapx-postgis] the API and data-manager database passwords must differ" >&2
  exit 1
fi

# Background-start the upstream entrypoint with whatever args compose passed
# (typically `postgres`).
docker-entrypoint.sh "$@" &
PG_PID=$!
if [ -n "$SHUTDOWN_SIGNAL" ]; then
  forward_signal "$SHUTDOWN_SIGNAL"
  finish_shutdown
fi

# Wait for postgres to accept connections, but bail if it crashes first.
until run_initialization_command pg_isready -U "$PG_USER" -d postgres -h /var/run/postgresql -q 2>/dev/null; do
  if ! kill -0 "$PG_PID" 2>/dev/null; then
    echo "[openmapx-postgis] postgres exited before becoming ready" >&2
    wait "$PG_PID" || true
    exit 1
  fi
  run_initialization_command sleep 1
done

# Run the SQL on stdin in one transaction. On a first start the upstream
# entrypoint initialises through a temporary server, which can answer before
# it has created the database and stops while it is used; every statement
# here is idempotent, so try again until the server that stays answers.
# `log_statement=none` keeps passwords off the postgres logs. The search path
# holds only the catalogs, so no object the API's role creates in the `public`
# schema it owns can stand in for a built-in this SQL calls as the superuser.
SUPERUSER_PGOPTIONS="-c log_statement=none -c search_path=pg_catalog,pg_temp"
run_sql() {
  local db="$1" sql
  sql=$(cat)
  for _ in $(seq 30); do
    if PGOPTIONS="$SUPERUSER_PGOPTIONS" \
      run_initialization_command psql -U "$PG_USER" -d "$db" -h /var/run/postgresql \
        -v ON_ERROR_STOP=1 --no-psqlrc -q --single-transaction \
        >/dev/null 2>&1 <<<"$sql"; then
      return 0
    fi
    kill -0 "$PG_PID" 2>/dev/null || break
    run_initialization_command sleep 1
  done
  PGOPTIONS="$SUPERUSER_PGOPTIONS" \
    run_initialization_command psql -U "$PG_USER" -d "$db" -h /var/run/postgresql \
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

APP_DB="${POSTGRES_DB:-$PG_USER}"
run_sql "$APP_DB" <<SQL
SELECT 'CREATE ROLE ${API_ROLE}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${API_ROLE}')
\gexec
SELECT 'CREATE ROLE ${DATA_MANAGER_ROLE}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DATA_MANAGER_ROLE}')
\gexec
ALTER ROLE ${API_ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN PASSWORD '${ESCAPED_API_PASSWORD}';
ALTER ROLE ${DATA_MANAGER_ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN PASSWORD '${ESCAPED_DATA_MANAGER_PASSWORD}';
-- Without the default "\$user" entry, a schema named after a role cannot
-- shadow the tables either role reads unqualified from public.
ALTER ROLE ${API_ROLE} SET search_path = public;
ALTER ROLE ${DATA_MANAGER_ROLE} SET search_path = public;
SELECT format('GRANT CREATE ON DATABASE %I TO ${API_ROLE}, ${DATA_MANAGER_ROLE}', current_database())
\gexec
ALTER SCHEMA public OWNER TO ${API_ROLE};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${DATA_MANAGER_ROLE} GRANT USAGE ON SCHEMAS TO ${API_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DATA_MANAGER_ROLE} GRANT SELECT ON TABLES TO ${API_ROLE};
-- Trusted extensions belong to the superuser, so data-manager's own
-- "CREATE EXTENSION IF NOT EXISTS" always finds them and owns none.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
-- Code a role writes must never run with another role's rights. The API reads
-- data-manager's schemas, and a function, rule, trigger, policy, domain check
-- or coercion runs as whoever's query fires it; a restore loads every table as
-- the superuser, which evaluates check constraints and generated columns.
-- These two event triggers refuse such code from every role but the superuser.
CREATE SCHEMA IF NOT EXISTS openmapx_guard;
REVOKE ALL ON SCHEMA openmapx_guard FROM PUBLIC;
-- Whether a stored expression calls a function, directly or through an
-- operator, other than the superuser's immutable or stable ones. Those cannot
-- write anything; the few stable ones that run a query given as text are
-- refused as well.
CREATE OR REPLACE FUNCTION openmapx_guard.calls_foreign_code(expression pg_node_tree)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
AS \$\$
  SELECT EXISTS (
    SELECT FROM (
      SELECT m[1]::oid AS id FROM regexp_matches(expression::text, ':funcid ([0-9]+)', 'g') m
      UNION ALL
      SELECT o.oprcode::oid FROM regexp_matches(expression::text, ':opno ([0-9]+)', 'g') m
        JOIN pg_operator o ON o.oid = m[1]::oid
    ) called
    LEFT JOIN pg_proc p ON p.oid = called.id
    LEFT JOIN pg_roles r ON r.oid = p.proowner
    WHERE called.id <> 0 AND (
      p.oid IS NULL OR NOT r.rolsuper OR p.provolatile NOT IN ('i', 's') OR p.proname ~ '_to_xml'))
\$\$;

CREATE OR REPLACE FUNCTION openmapx_guard.refuse_code()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS \$\$
BEGIN
  -- Data-manager writes no code at all: its schemas hold tables, indexes and
  -- plain views. The API writes only the trigger functions and enums its
  -- migrations need; both are checked when the command ends.
  IF current_user = '${DATA_MANAGER_ROLE}' OR (current_user = '${API_ROLE}' AND tg_tag NOT IN (
    'CREATE FUNCTION', 'ALTER FUNCTION', 'CREATE TRIGGER', 'ALTER TRIGGER', 'CREATE TYPE', 'ALTER TYPE'))
  THEN
    RAISE EXCEPTION '% may not run %', current_user, tg_tag USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
\$\$;
CREATE OR REPLACE FUNCTION openmapx_guard.check_ddl()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS \$\$
DECLARE
  data_manager_schemas constant text := '^((osm_search|notable_places)(__staging|__previous)?|ambient_places|overture_[a-z0-9_]{1,55})\$';
  api_schemas constant text := '^(data_manager|drizzle)\$';
  command record;
  relation oid;
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RETURN;
  END IF;
  FOR command IN SELECT classid, objid, object_type, object_identity FROM pg_event_trigger_ddl_commands() LOOP
    -- Each role creates only the schemas it needs, so neither can take a name
    -- another component trusts, such as a role's name or a schema a function
    -- of the tile server calls into.
    IF command.object_type = 'schema' AND (
      (current_user = '${DATA_MANAGER_ROLE}' AND command.object_identity !~ data_manager_schemas)
      OR (current_user = '${API_ROLE}' AND command.object_identity !~ api_schemas))
    THEN
      RAISE EXCEPTION '% may not create or rename a schema to %', current_user, command.object_identity
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- The API's functions carry its own prefix, so no call another role makes
    -- to a built-in or PostGIS function can resolve to one of them.
    IF current_user = '${API_ROLE}' AND command.object_type = 'function'
      AND command.object_identity !~ '\.openmapx_[a-z0-9_]+\('
    THEN
      RAISE EXCEPTION '% may name its functions only openmapx_*: %', current_user, command.object_identity
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Range types create constructor functions under their own name.
    IF current_user = '${API_ROLE}' AND command.object_type = 'type'
      AND EXISTS (SELECT FROM pg_type t WHERE t.oid = command.objid AND t.typtype NOT IN ('e', 'c'))
    THEN
      RAISE EXCEPTION '% may create only enum and composite types: %', current_user, command.object_identity
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Check constraints of tables and domains, and generated columns, run in
    -- the session that writes the row, a restoring superuser among them.
    relation := CASE command.classid
      WHEN 'pg_class'::regclass THEN command.objid
      WHEN 'pg_constraint'::regclass THEN (SELECT conrelid FROM pg_constraint WHERE oid = command.objid)
    END;
    IF EXISTS (
        SELECT FROM pg_constraint c
        WHERE c.contype = 'c' AND openmapx_guard.calls_foreign_code(c.conbin) AND (
          (relation IS NOT NULL AND c.conrelid = relation)
          OR (command.classid = 'pg_type'::regclass AND c.contypid = command.objid)
          OR (command.classid = 'pg_constraint'::regclass AND c.oid = command.objid)))
      OR (relation IS NOT NULL AND EXISTS (
        SELECT FROM pg_attrdef d
        JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = relation AND a.attgenerated <> '' AND openmapx_guard.calls_foreign_code(d.adbin)))
    THEN
      RAISE EXCEPTION 'check constraints and generated columns of % may call only built-in immutable functions', command.object_identity
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A view runs every function and coercion it contains, and with
    -- security_invoker every table it reads, as the role reading it. The API
    -- reads data-manager's views, so they may read only data-manager's own
    -- relations and contain no call or coercion.
    IF current_user = '${DATA_MANAGER_ROLE}' AND command.object_type = 'view' AND (
      EXISTS (SELECT FROM pg_class c WHERE c.oid = command.objid AND c.reloptions::text ~* 'security_invoker')
      -- Built-in functions are not recorded as dependencies, so look for any
      -- call or coercion in the stored query.
      OR EXISTS (
        SELECT FROM pg_rewrite r
        WHERE r.ev_class = command.objid
          AND r.ev_action::text ~ '[{](FUNCEXPR|AGGREF|WINDOWFUNC|COERCETODOMAIN|COERCEVIAIO|ARRAYCOERCEEXPR) ')
      OR EXISTS (
        SELECT FROM pg_rewrite r
        JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
        WHERE r.ev_class = command.objid AND (
          d.refclassid = 'pg_proc'::regclass
          OR (d.refclassid = 'pg_class'::regclass AND NOT EXISTS (
            SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.oid = d.refobjid AND n.nspname ~ data_manager_schemas))))
    ) THEN
      RAISE EXCEPTION 'data-manager may not define view % that calls functions, coerces types or reads other schemas', command.object_identity
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
END;
\$\$;
-- The event triggers run as the role issuing the command, which therefore
-- reaches this read-only catalog check and nothing else in the schema.
GRANT USAGE ON SCHEMA openmapx_guard TO PUBLIC;
REVOKE ALL ON FUNCTION openmapx_guard.refuse_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION openmapx_guard.check_ddl() FROM PUBLIC;
DROP EVENT TRIGGER IF EXISTS openmapx_guard_refuse_code;
CREATE EVENT TRIGGER openmapx_guard_refuse_code ON ddl_command_start WHEN TAG IN ('CREATE FUNCTION', 'ALTER FUNCTION', 'CREATE PROCEDURE', 'ALTER PROCEDURE', 'ALTER ROUTINE', 'CREATE AGGREGATE', 'ALTER AGGREGATE', 'CREATE OPERATOR', 'ALTER OPERATOR', 'CREATE CAST', 'CREATE CONVERSION', 'CREATE RULE', 'ALTER RULE', 'CREATE TRIGGER', 'ALTER TRIGGER', 'CREATE POLICY', 'ALTER POLICY', 'CREATE DOMAIN', 'ALTER DOMAIN', 'CREATE TYPE', 'ALTER TYPE') EXECUTE FUNCTION openmapx_guard.refuse_code();
DROP EVENT TRIGGER IF EXISTS openmapx_guard_check_ddl;
CREATE EVENT TRIGGER openmapx_guard_check_ddl ON ddl_command_end WHEN TAG IN ('CREATE SCHEMA', 'ALTER SCHEMA', 'CREATE TABLE', 'ALTER TABLE', 'CREATE VIEW', 'ALTER VIEW', 'CREATE FUNCTION', 'ALTER FUNCTION', 'CREATE TYPE', 'ALTER TYPE', 'CREATE DOMAIN', 'ALTER DOMAIN') EXECUTE FUNCTION openmapx_guard.check_ddl();
SQL
echo "[openmapx-postgis] database roles ${API_ROLE} and ${DATA_MANAGER_ROLE} ready"

# The tile server's login, and the role its functions run as. Martin may only
# call the functions in the `tiles` schema, so its role reads no table. Each
# function runs as `openmapx_tiles_owner`, which cannot log in, is no
# superuser and holds only what rendering a tile needs, so the code a tile
# reaches, OpenConditions' among it, never runs with more rights than that.
# The traffic-flow function calls OpenConditions' `conditions.segment_flow`,
# which reads three of its tables and calls PostGIS unqualified, hence
# `public` on the search path. Neither the API nor data-manager can put a
# function there that such a call resolves to, nor create `tiles` or
# `conditions` (see the event triggers above). The function can be created
# before OpenConditions is installed; PostGIS grants the owner role read
# access to those tables on every start, and a restore keeps the grants.
# Without MARTIN_DB_PASSWORD the tile server cannot log in.
TILES_ROLE="openmapx_tiles"
TILES_OWNER="openmapx_tiles_owner"
if [ -n "${MARTIN_DB_PASSWORD:-}" ]; then
  ESCAPED_TILES_PASSWORD=${MARTIN_DB_PASSWORD//\'/\'\'}
  TILES_LOGIN="LOGIN PASSWORD '${ESCAPED_TILES_PASSWORD}'"
else
  TILES_LOGIN="NOLOGIN PASSWORD NULL"
fi
run_sql "${POSTGRES_DB:-$PG_USER}" <<SQL
SELECT 'CREATE ROLE ${TILES_ROLE}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TILES_ROLE}')
\gexec
SELECT 'CREATE ROLE ${TILES_OWNER}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TILES_OWNER}')
\gexec
ALTER ROLE ${TILES_ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT ${TILES_LOGIN};
ALTER ROLE ${TILES_OWNER} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT NOLOGIN PASSWORD NULL;
CREATE SCHEMA IF NOT EXISTS tiles;
ALTER SCHEMA tiles OWNER TO CURRENT_USER;
REVOKE ALL ON SCHEMA tiles FROM PUBLIC;
GRANT USAGE ON SCHEMA tiles TO ${TILES_ROLE}, ${TILES_OWNER};
CREATE OR REPLACE FUNCTION tiles.segment_flow(z integer, x integer, y integer, query_params json)
  RETURNS bytea
  LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS \$\$
BEGIN
  RETURN conditions.segment_flow(z, x, y, query_params);
END;
\$\$;
ALTER FUNCTION tiles.segment_flow(integer, integer, integer, json) OWNER TO ${TILES_OWNER};
REVOKE ALL ON FUNCTION tiles.segment_flow(integer, integer, integer, json) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tiles.segment_flow(integer, integer, integer, json) TO ${TILES_ROLE};
SELECT 'GRANT USAGE ON SCHEMA conditions TO ${TILES_OWNER}'
  WHERE EXISTS (SELECT FROM pg_namespace WHERE nspname = 'conditions')
\gexec
SELECT format('GRANT SELECT ON TABLE %s TO ${TILES_OWNER}', c.oid::regclass)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'conditions' AND c.relname IN ('road_segment', 'segment_speed', 'source')
\gexec
SELECT 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA conditions TO ${TILES_OWNER}'
  WHERE EXISTS (SELECT FROM pg_namespace WHERE nspname = 'conditions')
\gexec
SQL
echo "[openmapx-postgis] tile server role ${TILES_ROLE} ready"

# Mark the sync as done. Healthcheck only returns success after this exists,
# so dependents waiting on `condition: service_healthy` start with a known-
# good password baseline.
run_initialization_command touch "$SYNC_SENTINEL"

# Hand control back to postgres in the foreground; container exit code
# matches postgres'.
finish_shutdown
