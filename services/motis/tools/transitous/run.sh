#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
shift || true

cd /transitous

_blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
_red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }

case "$ACTION" in
  generate-config)
    _blue "[transitous] Generating MOTIS config with GTFS-RT feeds..."

    ARGS="--skip-missing-files"
    REGION_GLOBS=()
    if [ -n "${TRANSITOUS_COUNTRIES:-}" ]; then
      _blue "[transitous] Using TRANSITOUS_COUNTRIES=${TRANSITOUS_COUNTRIES}"
      for raw in $(printf '%s' "$TRANSITOUS_COUNTRIES" | tr ',' ' '); do
        cc=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
        if [ -n "$cc" ] && ! printf '%s\n' "${REGION_GLOBS[@]}" 2>/dev/null | grep -qx "${cc}*"; then
          REGION_GLOBS+=("${cc}*")
        fi
      done
    else
      for f in out/*.gtfs.zip out/*.netex.zip; do
        [ -f "$f" ] || continue
        fname=$(basename "$f")
        cc=$(echo "$fname" | sed 's/[_-].*//')
        if [ -n "$cc" ] && ! printf '%s\n' "${REGION_GLOBS[@]}" 2>/dev/null | grep -qx "${cc}*"; then
          REGION_GLOBS+=("${cc}*")
        fi
      done
    fi

    python3 ./src/generate-motis-config.py $ARGS "${REGION_GLOBS[@]}"

    if [ -f out/config.yml ]; then
      rt_count=$(grep -c "protocol:" out/config.yml 2>/dev/null || echo "0")
      dataset_count=$(grep -c "path:" out/config.yml 2>/dev/null || echo "0")
      _green "[+] Generated MOTIS config: ${dataset_count} dataset(s), ${rt_count}+ real-time feed(s)"
    fi

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

    if [ -f .gitmodules ]; then
      git submodule update --init --checkout --remote -q 2>/dev/null || true
    fi

    if [ -f ./src/generate-attribution.py ]; then
      python3 ./src/generate-attribution.py
      if [ -f out/license.json ]; then
        count=$(python3 -c "import json; print(len(json.load(open('out/license.json'))))" 2>/dev/null || echo "?")
        _green "[+] Generated attribution data for ${count} feed(s) -> out/license.json"
      fi
    else
      _red "[x] generate-attribution.py not found in catalog"
      exit 1
    fi
    ;;

  *)
    _red "Usage: $0 <generate-config|generate-attribution>"
    exit 1
    ;;
esac
