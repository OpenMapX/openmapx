#!/usr/bin/env bash
set -euo pipefail

# Wrapper script for running the Transitous pipeline inside the import container.
# Called by manage.sh with: docker compose run transitous-import /run.sh [action] [args]
#
# Actions:
#   fetch [country_filter]    — Download and clean GTFS feeds
#   generate-config           — Generate MOTIS config.yml with GTFS-RT feeds + Lua scripts

ACTION="${1:-}"
shift || true

cd /transitous

_blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
_yellow(){ printf '\033[1;33m%s\033[0m\n' "$*"; }
_red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }

case "$ACTION" in
  fetch)
    COUNTRY_FILTER="${1:-}"

    # Try updating Transitland Atlas submodule (already cloned on host, this is a refresh attempt)
    if [ -f .gitmodules ]; then
      git submodule update --init --checkout --remote -q 2>/dev/null || true
    fi

    # Determine which feed files to process
    feed_files=()
    for f in feeds/*.json; do
      [ -f "$f" ] || continue
      if [ -n "$COUNTRY_FILTER" ]; then
        filename=$(basename "$f" .json)
        cc=$(echo "$filename" | sed 's/[.-].*//' | tr '[:upper:]' '[:lower:]')

        # Support comma-separated country codes
        match=false
        IFS=',' read -ra codes <<< "$COUNTRY_FILTER"
        for code in "${codes[@]}"; do
          code=$(echo "$code" | tr '[:upper:]' '[:lower:]' | xargs)
          if [ "$cc" = "$code" ]; then
            match=true
            break
          fi
        done
        [ "$match" = false ] && continue
      fi
      feed_files+=("$f")
    done

    if [ ${#feed_files[@]} -eq 0 ]; then
      _red "[x] No feed files found${COUNTRY_FILTER:+ for country: $COUNTRY_FILTER}"
      exit 1
    fi

    _blue "[transitous] Fetching ${#feed_files[@]} feed file(s)..."

    # Fetch feeds using Transitous's fetch.py (handles Transitland/MDB resolution,
    # gtfsclean, validation, conditional downloads)
    failed=0
    for feed_file in "${feed_files[@]}"; do
      _blue "[transitous] Processing $(basename "$feed_file")..."
      if ! python3 ./src/fetch.py "$feed_file"; then
        _yellow "[!] Some feeds in $(basename "$feed_file") failed — continuing"
        failed=$((failed + 1))
      fi
    done

    # Garbage collect orphaned downloads (only if some feeds succeeded)
    if [ "$failed" -eq 0 ] && [ -f ./src/garbage-collect.py ]; then
      _blue "[transitous] Cleaning up orphaned feeds..."
      python3 ./src/garbage-collect.py --non-interactive 2>/dev/null || true
    fi

    # Count results
    feed_count=$(find out/ -name "*.gtfs.zip" -o -name "*.netex.zip" 2>/dev/null | wc -l | tr -d ' ')
    _green "[+] Fetched ${feed_count} feed(s)${failed:+ ($failed feed file(s) had errors)}"
    ;;

  generate-config)
    _blue "[transitous] Generating MOTIS config with GTFS-RT feeds..."

    # Run Transitous's config generator (handles RT feed matching, Lua scripts,
    # GBFS feeds, protocol mapping, etc.)
    ARGS="--skip-missing-files"

    # Build region glob patterns from downloaded feeds to avoid processing
    # feed files for countries we don't have data for
    REGION_GLOBS=()
    for f in out/*.gtfs.zip out/*.netex.zip; do
      [ -f "$f" ] || continue
      fname=$(basename "$f")
      cc=$(echo "$fname" | sed 's/[_-].*//')
      if [ -n "$cc" ] && ! printf '%s\n' "${REGION_GLOBS[@]}" 2>/dev/null | grep -qx "${cc}*"; then
        REGION_GLOBS+=("${cc}*")
      fi
    done

    python3 ./src/generate-motis-config.py $ARGS "${REGION_GLOBS[@]}"

    # Count RT feeds in generated config
    if [ -f out/config.yml ]; then
      rt_count=$(grep -c "protocol:" out/config.yml 2>/dev/null || echo "0")
      dataset_count=$(grep -c "path:" out/config.yml 2>/dev/null || echo "0")
      _green "[+] Generated MOTIS config: ${dataset_count} dataset(s), ${rt_count}+ real-time feed(s)"
    fi

    # Copy Lua scripts if present
    if [ -d scripts/ ] && [ -d out/ ]; then
      mkdir -p out/scripts
      cp -r scripts/*.lua out/scripts/ 2>/dev/null || true
      lua_count=$(find out/scripts -name "*.lua" 2>/dev/null | wc -l | tr -d ' ')
      if [ "$lua_count" -gt 0 ]; then
        _green "[+] Copied ${lua_count} Lua import script(s)"
      fi
    fi
    ;;

  generate-attribution)
    _blue "[transitous] Generating feed attribution data..."

    # Init Transitland Atlas submodule (needed for resolving source metadata)
    if [ -f .gitmodules ]; then
      git submodule update --init --checkout --remote 2>/dev/null || \
        _yellow "[!] Could not update Transitland Atlas — using cached version"
    fi

    if [ -f ./src/generate-attribution.py ]; then
      python3 ./src/generate-attribution.py
      if [ -f out/license.json ]; then
        local count
        count=$(python3 -c "import json; print(len(json.load(open('out/license.json'))))" 2>/dev/null || echo "?")
        _green "[+] Generated attribution data for ${count} feed(s) -> out/license.json"
      fi
    else
      _red "[x] generate-attribution.py not found in catalog"
      exit 1
    fi
    ;;

  *)
    _red "Usage: $0 <fetch|generate-config|generate-attribution> [args]"
    exit 1
    ;;
esac
