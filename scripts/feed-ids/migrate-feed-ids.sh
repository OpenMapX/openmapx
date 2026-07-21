#!/usr/bin/env bash
#
# Regenerates poi-ingest data under the new feed ids on the single OpenMapX
# instance. For every entry in feed-id-map.json that is both `migrate: true`
# and has a `tableOld` (a poi-ingest source with an actual DB table — the
# manifest-only entries like tankerkoenig/afdc have no table and need no
# data migration, only the id-rename code change already applied elsewhere):
#
#   1. drop its old static + staging tables in the poi_ingest schema
#   2. delete its data_manager.poi_feed_state row (by old source_id)
#   3. clear its live-availability redis key (poi:live:<oldId>)
#   4. re-run `pnpm openmapx poi-ingest sync <newId>` to rebuild the table
#      and feed-state row under the new id (the live tier re-keys itself on
#      the next cron run, nothing to do there)
#
# This is a single-instance operation: there are no bookmarks or shared
# links that reference these internal table/source ids, and everything
# dropped here is a re-derivable cache, not user data. Every step is
# idempotent (DROP IF EXISTS, DELETE by id, redis DEL, and `poi-ingest sync`
# all tolerate being re-run), so this script is safe to run more than once.
#
# ORDERING: deploy the new (renamed) code FIRST, then run this. `poi-ingest
# sync <newId>` asks the running data-manager to ingest a source it only knows
# about under the new id, so the new integration code must already be live.
# All drops/deletes happen before any sync; the reader tolerates a missing
# table (cold-start) so the brief window between drop and re-sync just serves
# empty data on this single instance.
#
# Default mode is DRY RUN: it prints every command it would run and a
# summary, then exits 0 without touching the database, redis, or triggering
# any ingest. Pass --execute to actually run it.
#
# Usage:
#   scripts/feed-ids/migrate-feed-ids.sh              # dry run (default, safe)
#   scripts/feed-ids/migrate-feed-ids.sh --execute     # actually migrate
#
# Env overrides (all optional, default to the local compose setup):
#   COMPOSE_FILE     path to the rendered compose file
#   POSTGIS_SERVICE  compose service name for postgres (default: postgis)
#   REDIS_SERVICE    compose service name for redis (default: redis)
#   POSTGRES_USER    postgres user (default: postgres)
#   POSTGRES_DB      postgres database (default: openmapx)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MAP_FILE="${SCRIPT_DIR}/feed-id-map.json"

# Reads a single KEY=value line out of infra/docker/.env without shell-sourcing
# the file: some values in that file contain characters (pipes, etc.) that
# `source` would parse as shell syntax rather than literal text, and the file
# holds credentials we must never risk executing. grep/sed treat the matched
# value as plain text instead.
read_env_var() {
  local key="$1" file="$2"
  [[ -f "${file}" ]] || return 0
  grep -E "^${key}=" "${file}" | tail -n1 | sed -E "s/^${key}=//; s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/" || true
}

ENV_FILE="${REPO_ROOT}/infra/docker/.env"

COMPOSE_FILE="${COMPOSE_FILE:-${REPO_ROOT}/infra/docker/docker-compose.generated.yml}"
POSTGIS_SERVICE="${POSTGIS_SERVICE:-postgis}"
REDIS_SERVICE="${REDIS_SERVICE:-redis}"
POSTGRES_USER="${POSTGRES_USER:-$(read_env_var POSTGRES_USER "${ENV_FILE}")}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-$(read_env_var POSTGRES_DB "${ENV_FILE}")}"
POSTGRES_DB="${POSTGRES_DB:-openmapx}"

EXECUTE=false
for arg in "$@"; do
  case "${arg}" in
    --execute)
      EXECUTE=true
      ;;
    --dry-run) ;; # accepted for compatibility; this is the default
    *)
      echo "Unknown argument: ${arg}" >&2
      echo "Usage: $0 [--execute]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "${MAP_FILE}" ]]; then
  echo "feed-id-map.json not found at ${MAP_FILE}" >&2
  exit 1
fi

# Emits one "oldId<TAB>tableOld<TAB>newId" line per poi-ingest entry that
# needs data migration (migrate:true AND tableOld present). Manifest-only
# migrating entries (no tableOld) are intentionally excluded.
# (A portable while-read loop rather than `mapfile`/`readarray`, which are
# bash-4+-only builtins and unavailable on macOS's stock bash 3.2.)
ENTRIES=()
while IFS= read -r line; do
  ENTRIES+=("${line}")
done < <(
  node -e '
    const fs = require("node:fs");
    const map = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const e of map) {
      if (e.migrate && e.tableOld) {
        console.log([e.oldId, e.tableOld, e.newId].join("\t"));
      }
    }
  ' "${MAP_FILE}"
)

if [[ "${#ENTRIES[@]}" -eq 0 ]]; then
  echo "No migrating poi-ingest entries (migrate:true && tableOld) found in ${MAP_FILE}." >&2
  exit 1
fi

psql_exec() {
  local sql="$1"
  docker compose -f "${COMPOSE_FILE}" exec -T "${POSTGIS_SERVICE}" \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -c "${sql}"
}

redis_del() {
  local key="$1"
  docker compose -f "${COMPOSE_FILE}" exec -T "${REDIS_SERVICE}" redis-cli DEL "${key}"
}

drop_count=0
delete_count=0
redis_count=0
sync_count=0

if [[ "${EXECUTE}" == false ]]; then
  echo "DRY RUN — no commands will be executed. Pass --execute to run for real."
  echo
fi

echo "== Step 1: drop old tables, feed-state rows, and redis keys =="
for entry in "${ENTRIES[@]}"; do
  IFS=$'\t' read -r old_id table_old new_id <<<"${entry}"

  drop_sql="DROP TABLE IF EXISTS poi_ingest.\"${table_old}\" CASCADE;"
  drop_staging_sql="DROP TABLE IF EXISTS poi_ingest.\"${table_old}__staging\" CASCADE;"
  delete_sql="DELETE FROM data_manager.poi_feed_state WHERE source_id = '${old_id}';"
  redis_key="poi:live:${old_id}"

  if [[ "${EXECUTE}" == true ]]; then
    echo "-- ${old_id} (table: ${table_old})"
    psql_exec "${drop_sql}"
    psql_exec "${drop_staging_sql}"
    psql_exec "${delete_sql}"
    redis_del "${redis_key}"
  else
    echo "psql -c \"${drop_sql}\""
    echo "psql -c \"${drop_staging_sql}\""
    echo "psql -c \"${delete_sql}\""
    echo "redis-cli DEL \"${redis_key}\""
  fi

  drop_count=$((drop_count + 1))
  delete_count=$((delete_count + 1))
  redis_count=$((redis_count + 1))
done

echo
echo "== Step 2: re-ingest under new ids =="
sync_failures=()
for entry in "${ENTRIES[@]}"; do
  IFS=$'\t' read -r old_id table_old new_id <<<"${entry}"

  if [[ "${EXECUTE}" == true ]]; then
    echo "-- sync ${new_id}"
    if (cd "${REPO_ROOT}" && pnpm openmapx poi-ingest sync "${new_id}"); then
      :
    else
      echo "sync failed (creds/other?) — retry manually: ${new_id}"
      sync_failures+=("${new_id}")
    fi
  else
    echo "pnpm openmapx poi-ingest sync \"${new_id}\""
  fi

  sync_count=$((sync_count + 1))
done

echo
echo "== Summary =="
echo "Tables dropped (static+staging pairs): ${drop_count}"
echo "Feed-state rows deleted: ${delete_count}"
echo "Redis keys cleared: ${redis_count}"
echo "Sources re-synced: ${sync_count}"
if [[ "${EXECUTE}" == true ]]; then
  if [[ "${#sync_failures[@]}" -gt 0 ]]; then
    echo "Sync failures (retry manually): ${sync_failures[*]}"
  else
    echo "Sync failures: none"
  fi
else
  echo
  echo "DRY RUN complete — no changes were made. Pass --execute to run for real."
fi
