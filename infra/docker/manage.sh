#!/usr/bin/env bash
set -euo pipefail

# OpenMapX Infrastructure Manager
# Central CLI for the self-hosted stack: downloads source data (OSM, GTFS,
# map styles), builds service indexes, and manages the Docker Compose
# services (start/stop/restart/recreate/logs/health checks).
#
# Requirements: curl, jq, docker (with compose plugin)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-${SCRIPT_DIR}/data}"
CONFIG="${SCRIPT_DIR}/data.conf"

# Load config
if [ -f "$CONFIG" ]; then
  # shellcheck source=data.conf
  source "$CONFIG"
fi

REGION="${REGION:-planet}"
GEOFABRIK_BASE="https://download.geofabrik.de"
PLANET_URL="https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf"
_GITHUB_SSH=""
github_url() {
  # Convert a GitHub HTTPS URL to SSH if the server has SSH access
  local url="$1"
  if [ -z "$_GITHUB_SSH" ]; then
    # ssh -T exits with 1 on success for GitHub (it closes the session)
    # but exits with 255 on connection/auth failure
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes -T git@github.com &>/dev/null
    if [ $? -eq 1 ]; then
      _GITHUB_SSH=yes
    else
      _GITHUB_SSH=no
    fi
  fi
  if [ "$_GITHUB_SSH" = "yes" ]; then
    echo "$url" | sed 's|https://github.com/|git@github.com:|'
  else
    echo "$url"
  fi
}

TRANSITOUS_REPO="https://github.com/public-transport/transitous.git"
MAX_CONCURRENT_DOWNLOADS="${MAX_CONCURRENT_DOWNLOADS:-5}"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

# Colors
_blue()   { printf '\033[0;34m%s\033[0m\n' "$*"; }
_green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
_red()    { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
_bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

log()  { _blue   "[openmapx] $*"; }
ok()   { _green  "[+] $*"; }
warn() { _yellow "[!] $*"; }
err()  { _red    "[x] $*"; }

# Helpers

require_cmd() {
  for cmd in "$@"; do
    if ! command -v "$cmd" &>/dev/null; then
      err "Required command not found: $cmd"
      exit 1
    fi
  done
}

# Hardlink $1 -> $2, skipping if already the same inode
safe_link() {
  local src="$1" dest="$2"
  if [ -f "$dest" ] && [ "$(stat -c%i "$src" 2>/dev/null || stat -f%i "$src")" = "$(stat -c%i "$dest" 2>/dev/null || stat -f%i "$dest")" ]; then
    return 0
  fi
  ln -f "$src" "$dest"
}

# Profile/Service Mapping
# Maps between service names, profiles, and docker compose flags.

ALL_PROFILES=(proxy app routing transit pelias nominatim photon overpass tiles martin)

service_to_profile() {
  case "$1" in
    traefik)                                                    echo "proxy" ;;
    api|web)                                                    echo "app" ;;
    valhalla|osrm)                                              echo "routing" ;;
    motis|otp)                                                  echo "transit" ;;
    elasticsearch|pelias-api|pelias-placeholder|pelias-pip)     echo "pelias" ;;
    nominatim)                                                  echo "nominatim" ;;
    photon)                                                     echo "photon" ;;
    overpass)                                                   echo "overpass" ;;
    tileserver)                                                 echo "tiles" ;;
    martin)                                                     echo "martin" ;;
    postgis|redis)                                              echo "" ;;
    *)                                                          echo "" ;;
  esac
}

profile_to_services() {
  case "$1" in
    core)       echo "postgis redis" ;;
    proxy)      echo "traefik" ;;
    app)        echo "api web well-known" ;;
    routing)    echo "valhalla osrm" ;;
    transit)    echo "motis otp" ;;
    pelias)     echo "elasticsearch pelias-api pelias-placeholder pelias-pip" ;;
    nominatim)  echo "nominatim" ;;
    photon)     echo "photon" ;;
    overpass)   echo "overpass" ;;
    tiles)      echo "tileserver" ;;
    martin)     echo "martin" ;;
    *)          echo "" ;;
  esac
}

is_profile() {
  case "$1" in
    core|proxy|app|routing|transit|pelias|nominatim|photon|overpass|tiles|martin) return 0 ;;
    *) return 1 ;;
  esac
}

is_service() {
  case "$1" in
    postgis|redis|traefik|api|web|well-known|valhalla|osrm|motis|otp) return 0 ;;
    elasticsearch|pelias-api|pelias-placeholder|pelias-pip) return 0 ;;
    nominatim|photon|overpass|tileserver|martin)            return 0 ;;
    *) return 1 ;;
  esac
}

# Resolve targets (service names, profile names, or "all") into
# two arrays: _PROFILES (for --profile flags) and _SERVICES (explicit service names).
# When a profile is given, _SERVICES stays empty so compose starts the whole profile.
# When a service is given, its profile is added to _PROFILES and the service to _SERVICES.
resolve_targets() {
  _PROFILES=()
  _SERVICES=()

  for target in "$@"; do
    if [ "$target" = "all" ]; then
      _PROFILES=("${ALL_PROFILES[@]}")
      _SERVICES=()
      return 0
    elif is_profile "$target"; then
      if [ "$target" = "core" ]; then
        _SERVICES+=(postgis redis)
      else
        local dup=false
        for p in "${_PROFILES[@]}"; do [ "$p" = "$target" ] && dup=true; done
        $dup || _PROFILES+=("$target")
      fi
    elif is_service "$target"; then
      _SERVICES+=("$target")
      local profile
      profile=$(service_to_profile "$target")
      if [ -n "$profile" ]; then
        local dup=false
        for p in "${_PROFILES[@]}"; do [ "$p" = "$profile" ] && dup=true; done
        $dup || _PROFILES+=("$profile")
      fi
    else
      err "Unknown service or profile: $target"
      return 1
    fi
  done
}

# Build a docker compose command string with the resolved --profile flags
compose_with_profiles() {
  local cmd="docker compose -f $COMPOSE_FILE"
  for p in "${_PROFILES[@]}"; do
    cmd+=" --profile $p"
  done
  echo "$cmd"
}

ensure_dirs() {
  mkdir -p \
    "${DATA_DIR}/osm" \
    "${DATA_DIR}/gtfs" \
    "${DATA_DIR}/osrm" \
    "${DATA_DIR}/valhalla" \
    "${DATA_DIR}/otp" \
    "${DATA_DIR}/motis" \
    "${DATA_DIR}/tileserver" \
    "${DATA_DIR}/tileserver/fonts" \
    "${DATA_DIR}/tileserver/sprites" \
    "${DATA_DIR}/tileserver/styles" \
    "${DATA_DIR}/pelias/openstreetmap" \
    "${DATA_DIR}/pelias/whosonfirst" \
    "${DATA_DIR}/pelias/placeholder" \
    "${DATA_DIR}/nominatim" \
    "${DATA_DIR}/photon" \
    "${DATA_DIR}/overpass/db" \
    "${DATA_DIR}/overpass/osm"
}

find_pbf() {
  find "${DATA_DIR}/osm" -maxdepth 1 -name "*.osm.pbf" -type f 2>/dev/null | sort | head -1
}

is_planet() {
  local pbf
  pbf=$(find_pbf)
  [ -n "$pbf" ] && [ "$(file_size "$pbf")" -gt 50000000000 ]
}

human_size() {
  local bytes="$1"
  if [ "$bytes" -ge 1073741824 ]; then
    printf "%.1f GB" "$(echo "$bytes / 1073741824" | bc -l)"
  elif [ "$bytes" -ge 1048576 ]; then
    printf "%.1f MB" "$(echo "$bytes / 1048576" | bc -l)"
  elif [ "$bytes" -ge 1024 ]; then
    printf "%.1f KB" "$(echo "$bytes / 1024" | bc -l)"
  else
    echo "${bytes} B"
  fi
}

file_size() {
  if [ -f "$1" ]; then
    stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# Integration Manifest Discovery
# Reads infrastructure declarations from integration manifests.

INTEGRATIONS_DIR="${SCRIPT_DIR}/../../integrations"

# List enabled integration IDs (all that exist minus DISABLED_INTEGRATIONS)
list_enabled_integrations() {
  local disabled="${DISABLED_INTEGRATIONS:-}"
  for dir in "${INTEGRATIONS_DIR}"/*/; do
    local manifest="${dir}manifest.json"
    [ -f "$manifest" ] || continue
    local id
    id=$(jq -r '.id // empty' "$manifest" 2>/dev/null)
    [ -z "$id" ] && continue
    # Check if disabled
    if [ -n "$disabled" ]; then
      local is_disabled=false
      for d in $disabled; do
        [ "$d" = "$id" ] && is_disabled=true
      done
      $is_disabled && continue
    fi
    echo "$id"
  done
}

# Get infrastructure JSON for an integration ID (empty if none)
get_infra() {
  local manifest="${INTEGRATIONS_DIR}/$1/manifest.json"
  [ -f "$manifest" ] || return
  jq -r '.infrastructure // empty' "$manifest" 2>/dev/null
}

# List integrations that declare infrastructure, one per line:
#   id|dockerProfile|services (comma-sep)|dataRequirements (comma-sep)|planetScale
discover_integration_infra() {
  for id in $(list_enabled_integrations); do
    local manifest="${INTEGRATIONS_DIR}/${id}/manifest.json"
    local infra
    infra=$(jq -c '.infrastructure // empty' "$manifest" 2>/dev/null)
    [ -z "$infra" ] && continue
    local profile services data ps
    profile=$(echo "$infra" | jq -r '.dockerProfile // "--"')
    services=$(echo "$infra" | jq -r '(.services // []) | join(",")')
    data=$(echo "$infra" | jq -r '(.dataRequirements // []) | join(",")')
    ps=$(echo "$infra" | jq -r 'if has("planetScale") then .planetScale else true end')
    [ -z "$services" ] && services="--"
    [ -z "$data" ] && data="--"
    echo "${id}|${profile}|${services}|${data}|${ps}"
  done
}

# Get unique docker profiles needed by enabled integrations
get_needed_profiles() {
  discover_integration_infra | awk -F'|' '$2 != "--" { print $2 }' | sort -u
}

# Get unique data requirements from enabled integrations
get_needed_data() {
  discover_integration_infra | awk -F'|' '$4 != "--" { print $4 }' | tr ',' '\n' | sort -u
}

# Check if an integration is planet-scale capable (default: true)
is_integration_planet_capable() {
  local manifest="${INTEGRATIONS_DIR}/$1/manifest.json"
  [ -f "$manifest" ] || return 0
  local ps
  ps=$(jq -r 'if .infrastructure.planetScale == false then "false" else "true" end' "$manifest" 2>/dev/null)
  [ "$ps" = "true" ]
}

cmd_integrations() {
  require_cmd jq

  local filter_profile="" filter_data="" json_output=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) filter_profile="$2"; shift 2 ;;
      --data)    filter_data="$2"; shift 2 ;;
      --json)    json_output=true; shift ;;
      *)         err "Unknown option: $1"; return 1 ;;
    esac
  done

  local lines=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local id profile services data ps
    id=$(echo "$line" | cut -d'|' -f1)
    profile=$(echo "$line" | cut -d'|' -f2)
    services=$(echo "$line" | cut -d'|' -f3)
    data=$(echo "$line" | cut -d'|' -f4)
    ps=$(echo "$line" | cut -d'|' -f5)

    # Apply filters
    if [ -n "$filter_profile" ] && [ "$profile" != "$filter_profile" ]; then
      continue
    fi
    if [ -n "$filter_data" ]; then
      echo "$data" | grep -q "$filter_data" || continue
    fi

    lines+=("$line")
  done < <(discover_integration_infra)

  if [ ${#lines[@]} -eq 0 ]; then
    warn "No integrations with infrastructure declarations found"
    return 0
  fi

  if $json_output; then
    # JSON output
    local json="["
    local first=true
    for line in "${lines[@]}"; do
      local id profile services data ps
      id=$(echo "$line" | cut -d'|' -f1)
      profile=$(echo "$line" | cut -d'|' -f2)
      services=$(echo "$line" | cut -d'|' -f3)
      data=$(echo "$line" | cut -d'|' -f4)
      ps=$(echo "$line" | cut -d'|' -f5)
      $first || json+=","
      first=false
      # Build JSON object using jq for proper escaping
      json+=$(jq -nc \
        --arg id "$id" \
        --arg profile "$([ "$profile" = "--" ] && echo "" || echo "$profile")" \
        --arg services "$([ "$services" = "--" ] && echo "" || echo "$services")" \
        --arg data "$([ "$data" = "--" ] && echo "" || echo "$data")" \
        --arg ps "$ps" \
        '{id:$id, dockerProfile:($profile|if .=="" then null else . end), services:($services|if .=="" then [] else split(",") end), dataRequirements:($data|if .=="" then [] else split(",") end), planetScale:($ps=="true")}')
    done
    json+="]"
    echo "$json" | jq .
    return 0
  fi

  # Table output
  printf "\n"
  printf "  %-24s %-12s %-30s %-20s %s\n" "INTEGRATION" "PROFILE" "SERVICES" "DATA" "PLANET"
  printf "  %-24s %-12s %-30s %-20s %s\n" "-----------" "-------" "--------" "----" "------"
  for line in "${lines[@]}"; do
    local id profile services data ps
    id=$(echo "$line" | cut -d'|' -f1)
    profile=$(echo "$line" | cut -d'|' -f2)
    services=$(echo "$line" | cut -d'|' -f3 | tr ',' ', ')
    data=$(echo "$line" | cut -d'|' -f4 | tr ',' ', ')
    ps=$(echo "$line" | cut -d'|' -f5)
    local ps_display="yes"
    [ "$ps" = "false" ] && ps_display="NO"
    printf "  %-24s %-12s %-30s %-20s %s\n" "$id" "$profile" "$services" "$data" "$ps_display"
  done

  # Summary
  local profiles_list data_list
  profiles_list=$(printf '%s\n' "${lines[@]}" | awk -F'|' '$2 != "--" { print $2 }' | sort -u | tr '\n' ', ' | sed 's/,$//')
  data_list=$(printf '%s\n' "${lines[@]}" | awk -F'|' '$4 != "--" { print $4 }' | tr ',' '\n' | sort -u | tr '\n' ', ' | sed 's/,$//')

  printf "\n"
  [ -n "$profiles_list" ] && echo "  Profiles needed: ${profiles_list}"
  [ -n "$data_list" ] && echo "  Data needed:     ${data_list}"
  printf "\n"
}

# Download OSM PBF

cmd_download_osm() {
  local region="${1:-$REGION}"
  ensure_dirs

  local url dest slug
  if [ "$region" = "planet" ]; then
    slug="planet"
    url="$PLANET_URL"
    dest="${DATA_DIR}/osm/planet.osm.pbf"
    log "Downloading planet OSM PBF (~70 GB, this will take a while)..."
  else
    slug="${region##*/}"
    url="${GEOFABRIK_BASE}/${region}-latest.osm.pbf"
    dest="${DATA_DIR}/osm/${slug}.osm.pbf"
    log "Downloading OSM PBF: ${region}"
  fi

  log "URL: ${url}"
  log "Destination: ${dest}"

  if [ -f "$dest" ]; then
    log "File exists, checking for updates (If-Modified-Since)..."
    local http_code
    http_code=$(curl -fSL -z "$dest" -o "$dest" -w "%{http_code}" "$url" 2>/dev/null || echo "000")
    if [ "$http_code" = "304" ]; then
      ok "Already up to date: ${slug}.osm.pbf ($(human_size "$(file_size "$dest")"))"
      return 0
    fi
  else
    curl -fSL --progress-bar -o "$dest" "$url"
  fi

  if [ -f "$dest" ]; then
    ok "Downloaded: ${slug}.osm.pbf ($(human_size "$(file_size "$dest")"))"
  else
    err "Download failed"
    return 1
  fi

  cmd_convert_overpass
}

cmd_convert_overpass() {
  ensure_dirs
  local pbf
  pbf=$(find_pbf)
  if [ -z "$pbf" ]; then
    err "No OSM PBF found. Run: ./manage.sh download-osm"
    return 1
  fi

  if ! command -v osmium >/dev/null 2>&1; then
    err "osmium-tool not installed. Install with: sudo apt install osmium-tool"
    return 1
  fi

  local bz2_dest="${DATA_DIR}/overpass/osm/data.osm.bz2"
  log "Converting PBF → bz2 for Overpass..."
  if osmium cat -o "$bz2_dest" "$pbf"; then
    ok "Converted: data.osm.bz2 ($(human_size "$(file_size "$bz2_dest")"))"
  else
    err "bz2 conversion failed"
    rm -f "$bz2_dest" 2>/dev/null
    return 1
  fi
}

# Download GTFS Feeds

cmd_download_gtfs() {
  local url="${1:-}"
  local slug="${2:-}"

  if [ -z "$url" ]; then
    err "Usage: manage.sh add-feed <url> [slug]"
    return 1
  fi

  if [ -z "$slug" ]; then
    slug=$(basename "$url" | sed 's/\.zip$//' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/_/g')
  fi

  ensure_dirs

  local dest="${DATA_DIR}/gtfs/${slug}.gtfs.zip"
  log "Downloading GTFS feed: ${slug}"

  if curl -fSL --progress-bar --max-time 600 -o "$dest" "$url" 2>/dev/null; then
    if [ -f "$dest" ] && [ "$(file_size "$dest")" -gt 100 ]; then
      ok "Downloaded: ${slug}.gtfs.zip ($(human_size "$(file_size "$dest")"))"
    else
      rm -f "$dest"
      err "Download produced empty/invalid file: ${slug}"
      return 1
    fi
  else
    rm -f "$dest"
    err "Download failed: ${slug}"
    return 1
  fi
}

update_transitous_catalog() {
  local catalog_dir="${DATA_DIR}/.transitous-catalog"

  if [ -d "$catalog_dir/.git" ]; then
    log "Updating Transitous catalog..."
    git -C "$catalog_dir" pull --ff-only -q 2>/dev/null || warn "Could not update Transitous catalog — using cached version"
    git -C "$catalog_dir" submodule update --init --depth 1 -q 2>/dev/null || true
  else
    log "Cloning Transitous feed catalog..."
    rm -rf "$catalog_dir"
    git clone --depth 1 --recurse-submodules --shallow-submodules -q "$(github_url "$TRANSITOUS_REPO")" "$catalog_dir"
  fi
}

cmd_download_all_feeds() {
  local country_filter="${1:-${GTFS_COUNTRIES:-}}"
  ensure_dirs
  mkdir -p "${DATA_DIR}/.transitous-downloads"

  # Ensure api-keys.json exists (gitignored, created empty if missing)
  local keys_file="${SCRIPT_DIR}/services/transitous/api-keys.json"
  [ -f "$keys_file" ] || echo '{}' > "$keys_file"

  # Clone or update the Transitous catalog
  update_transitous_catalog

  # Build the Transitous import image if needed
  log "Preparing Transitous import tools..."
  if ! docker compose -f "$COMPOSE_FILE" --profile build build transitous-import 2>/dev/null; then
    err "Failed to build Transitous import image"
    return 1
  fi

  # Run the Transitous fetch pipeline (resolves Transitland/MDB references,
  # downloads feeds, validates, runs gtfsclean)
  log "Fetching GTFS feeds via Transitous pipeline..."
  if ! docker compose -f "$COMPOSE_FILE" --profile build \
    run --rm --user "$(id -u):$(id -g)" transitous-import /run.sh fetch "$country_filter"; then
    warn "Some feeds failed to download — check output above"
  fi

  # Show total GTFS size
  local feed_count
  feed_count=$(find "${DATA_DIR}/gtfs" -name "*.gtfs.zip" -o -name "*.netex.zip" 2>/dev/null | wc -l | tr -d ' ')
  local gtfs_size
  gtfs_size=$(du -sh "${DATA_DIR}/gtfs" 2>/dev/null | cut -f1 || echo "0")
  ok "GTFS feeds: ${feed_count} feeds, ${gtfs_size} total"
}

# Download Map Style, Fonts, Sprites

cmd_download_style() {
  require_cmd curl unzip
  ensure_dirs

  local style_dir="${DATA_DIR}/tileserver/styles"
  local fonts_dir="${DATA_DIR}/tileserver/fonts"
  local sprites_dir="${DATA_DIR}/tileserver/sprites"

  # Download OpenMapTiles fonts (PBF glyphs for map label rendering)
  if [ -d "${fonts_dir}/Noto Sans Regular" ]; then
    ok "Fonts already downloaded"
  else
    log "Downloading OpenMapTiles fonts (PBF glyphs)..."
    log "  Building from openmaptiles/fonts repo (requires Node.js)..."

    if ! command -v node &>/dev/null; then
      warn "Node.js not found. Downloading pre-built font glyphs instead..."
      local fonts_url="https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip"
      local fonts_tmp="${DATA_DIR}/.fonts-tmp.zip"
      if curl -fSL --progress-bar -o "$fonts_tmp" "$fonts_url" 2>/dev/null; then
        unzip -qo "$fonts_tmp" -d "$fonts_dir"
        rm -f "$fonts_tmp"
        ok "Fonts downloaded from release"
      else
        err "Could not download fonts. Install Node.js or download manually."
        return 1
      fi
    else
      local font_build_dir="${DATA_DIR}/.font-build"
      rm -rf "$font_build_dir"
      git clone --depth 1 -q "$(github_url "https://github.com/openmaptiles/fonts.git")" "$font_build_dir"
      (cd "$font_build_dir" && npm install --silent && node generate.js)
      cp -r "${font_build_dir}/_output/"* "$fonts_dir/"
      rm -rf "$font_build_dir"
      ok "Fonts generated"
    fi
  fi

  # Download map styles and their sprites
  download_style_and_sprites() {
    local name="$1"     # e.g. "osm-bright"
    local repo="$2"     # e.g. "openmaptiles/osm-bright-gl-style"
    local branch="${3:-master}"

    if [ -f "${style_dir}/${name}/style.json" ]; then
      ok "${name} style already exists"
      return 0
    fi

    log "Downloading ${name} style..."
    mkdir -p "${style_dir}/${name}"

    # Download style.json from raw GitHub
    curl -fsSL -o "${style_dir}/${name}/style.json" \
      "https://raw.githubusercontent.com/${repo}/${branch}/style.json"

    # Download sprite files from GitHub Pages
    local gh_pages_base="https://${repo%%/*}.github.io/${repo##*/}"
    for file in sprite.json sprite.png sprite@2x.json sprite@2x.png; do
      curl -fsSL -o "${style_dir}/${name}/${file}" \
        "${gh_pages_base}/${file}" 2>/dev/null || true
    done

    # Patch style.json for local TileServer GL serving
    patch_style "${style_dir}/${name}/style.json"
    ok "${name} style downloaded"
  }

  download_style_and_sprites "osm-bright" "openmaptiles/osm-bright-gl-style"
  download_style_and_sprites "dark-matter" "openmaptiles/dark-matter-gl-style"
  download_style_and_sprites "positron" "openmaptiles/positron-gl-style"
  download_style_and_sprites "osm-liberty" "maputnik/osm-liberty" "gh-pages"

  ok "Map styles, fonts, and sprites ready for TileServer GL"
}

# Patch a style.json to use TileServer GL local serving placeholders.
# TileServer GL auto-resolves these to absolute URLs when serving:
#   mbtiles://{openmapx}  → local MBTiles data source
#   {fontstack}/{range}.pbf → local font glyphs
#   {styleJsonFolder}/sprite → sprite files next to style.json
patch_style() {
  local style_file="$1"
  [ -f "$style_file" ] || return 0

  if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$style_file') as f:
    style = json.load(f)

for src_name, src in style.get('sources', {}).items():
    if src.get('type') == 'vector':
        src.clear()
        src['type'] = 'vector'
        src['url'] = 'mbtiles://{openmapx}'

style['glyphs'] = '{fontstack}/{range}.pbf'
style['sprite'] = '{styleJsonFolder}/sprite'

with open('$style_file', 'w') as f:
    json.dump(style, f, indent=2, ensure_ascii=False)
" 2>/dev/null && return 0
  fi

  warn "Python3 not available, skipping style patching. Manual editing may be needed."
}

# Remove GTFS Feed

cmd_remove_feed() {
  local slug="${1:-}"
  if [ -z "$slug" ]; then
    err "Usage: manage.sh remove-feed <slug>"
    return 1
  fi

  local src="${DATA_DIR}/gtfs/${slug}.gtfs.zip"
  if [ ! -f "$src" ]; then
    err "Feed not found: ${slug}"
    return 1
  fi

  rm -f "$src"
  rm -f "${DATA_DIR}/otp/${slug}.gtfs.zip"
  rm -f "${DATA_DIR}/motis/${slug}.gtfs.zip"

  ok "Removed feed: ${slug}"
}

# Integration Infrastructure Commands

cmd_check_data() {
  require_cmd jq

  local has_osm=false has_gtfs=false
  local pbf
  pbf=$(find_pbf)
  [ -n "$pbf" ] && has_osm=true

  local gtfs_count=0
  for f in "${DATA_DIR}/gtfs/"*.zip; do
    [ -f "$f" ] || continue
    gtfs_count=$((gtfs_count + 1))
  done
  [ "$gtfs_count" -gt 0 ] && has_gtfs=true

  printf "\n"
  log "Data requirements from enabled integrations:"
  printf "\n"

  # Collect which integrations need what
  local osm_users="" gtfs_users=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local id data
    id=$(echo "$line" | cut -d'|' -f1)
    data=$(echo "$line" | cut -d'|' -f4)
    if echo "$data" | grep -q "osm-pbf"; then
      osm_users="${osm_users:+$osm_users, }${id}"
    fi
    if echo "$data" | grep -q "gtfs-feeds"; then
      gtfs_users="${gtfs_users:+$gtfs_users, }${id}"
    fi
  done < <(discover_integration_infra)

  # Report osm-pbf
  if [ -n "$osm_users" ]; then
    _bold "  osm-pbf"
    echo "    Required by: ${osm_users}"
    if $has_osm; then
      local pbf_size
      pbf_size=$(human_size "$(file_size "$pbf")")
      ok "    Status: OK ($(basename "$pbf"), ${pbf_size})"
    else
      err "    Status: MISSING"
      echo "    Run: ./manage.sh download-osm <region>"
    fi
    printf "\n"
  fi

  # Report gtfs-feeds
  if [ -n "$gtfs_users" ]; then
    _bold "  gtfs-feeds"
    echo "    Required by: ${gtfs_users}"
    if $has_gtfs; then
      local gtfs_size
      gtfs_size=$(du -sh "${DATA_DIR}/gtfs/" 2>/dev/null | awk '{print $1}')
      ok "    Status: OK (${gtfs_count} feeds, ${gtfs_size})"
    else
      err "    Status: MISSING"
      echo "    Run: ./manage.sh download-all-feeds [countries]"
    fi
    printf "\n"
  fi

  if [ -z "$osm_users" ] && [ -z "$gtfs_users" ]; then
    warn "No data requirements declared by any enabled integration"
  fi
}

cmd_profiles() {
  require_cmd jq

  local infra_lines=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    infra_lines+=("$line")
  done < <(discover_integration_infra)

  if [ ${#infra_lines[@]} -eq 0 ]; then
    warn "No integrations with infrastructure declarations found"
    return 0
  fi

  local planet=false
  is_planet && planet=true

  printf "\n"
  log "Docker profiles needed based on enabled integrations:"
  printf "\n"

  # Collect profile->integrations mapping using parallel arrays
  local profile_names=() profile_ids=()
  for line in "${infra_lines[@]}"; do
    local id profile ps
    id=$(echo "$line" | cut -d'|' -f1)
    profile=$(echo "$line" | cut -d'|' -f2)
    ps=$(echo "$line" | cut -d'|' -f5)

    [ "$profile" = "--" ] && continue

    if $planet && [ "$ps" = "false" ]; then
      warn "  Skipping ${id} (not planet-scale capable)"
      continue
    fi

    # Find existing profile entry or create new
    local found=false idx=0
    if [ ${#profile_names[@]} -gt 0 ]; then
      for pn in "${profile_names[@]}"; do
        if [ "$pn" = "$profile" ]; then
          profile_ids[$idx]="${profile_ids[$idx]}, ${id}"
          found=true
          break
        fi
        idx=$((idx + 1))
      done
    fi
    if ! $found; then
      profile_names+=("$profile")
      profile_ids+=("$id")
    fi
  done

  if [ ${#profile_names[@]} -eq 0 ]; then
    warn "No Docker profiles needed"
    return 0
  fi

  # Sort and display
  local sorted_profiles
  sorted_profiles=$(printf '%s\n' "${profile_names[@]}" | sort)
  while IFS= read -r profile; do
    local idx=0
    for pn in "${profile_names[@]}"; do
      if [ "$pn" = "$profile" ]; then
        printf "  %-14s (%s)\n" "$profile" "${profile_ids[$idx]}"
        break
      fi
      idx=$((idx + 1))
    done
  done <<< "$sorted_profiles"

  # Build start command
  local compose_cmd="docker compose"
  while IFS= read -r profile; do
    compose_cmd+=" --profile ${profile}"
  done <<< "$sorted_profiles"
  compose_cmd+=" up -d"

  printf "\n"
  log "Start command:"
  echo "  ${compose_cmd}"
  printf "\n"
}

# Link Source Data into Service Directories

cmd_link() {
  ensure_dirs

  local pbf
  pbf=$(find_pbf)
  local linked=0
  local planet=false

  if [ -n "$pbf" ]; then
    local pbf_name pbf_bytes
    pbf_name=$(basename "$pbf")
    pbf_bytes=$(file_size "$pbf")
    log "Linking OSM PBF: ${pbf_name} ($(human_size "$pbf_bytes"))"

    # Check if planet-scale
    if [ "$pbf_bytes" -gt 50000000000 ]; then
      planet=true
      warn "Planet-scale PBF detected"
    fi

    # Valhalla — handles planet well (~16 GB RAM, ~8h build)
    safe_link "$pbf" "${DATA_DIR}/valhalla/${pbf_name}" && ok "  -> valhalla/${pbf_name}"
    linked=$((linked + 1))

    # MOTIS — optional OSM for street routing
    safe_link "$pbf" "${DATA_DIR}/motis/${pbf_name}" && ok "  -> motis/${pbf_name}"
    linked=$((linked + 1))

    # Pelias — for geocoding import
    safe_link "$pbf" "${DATA_DIR}/pelias/openstreetmap/data.osm.pbf" && ok "  -> pelias/openstreetmap/data.osm.pbf"
    linked=$((linked + 1))

    # Nominatim — for geocoding import
    safe_link "$pbf" "${DATA_DIR}/nominatim/data.osm.pbf" && ok "  -> nominatim/data.osm.pbf"
    linked=$((linked + 1))

    # Overpass — uses pre-converted bz2 (created by download-osm)
    local overpass_bz2="${DATA_DIR}/overpass/osm/data.osm.bz2"
    if [ -f "$overpass_bz2" ]; then
      ok "  -> overpass/osm/data.osm.bz2 (already exists)"
    else
      warn "  No bz2 found for Overpass. Run: ./manage.sh convert-overpass"
    fi
    linked=$((linked + 1))

    if [ "$planet" = true ]; then
      warn "Skipping OSRM link (planet PBF needs ~200 GB RAM for OSRM — use Valhalla instead)"
      warn "Skipping OTP link (planet PBF too large for OTP — use MOTIS instead)"
    else
      # OSRM — region-scale only
      safe_link "$pbf" "${DATA_DIR}/osrm/region.osm.pbf" && ok "  -> osrm/region.osm.pbf"
      linked=$((linked + 1))

      # OTP — region-scale only
      safe_link "$pbf" "${DATA_DIR}/otp/${pbf_name}" && ok "  -> otp/${pbf_name}"
      linked=$((linked + 1))
    fi
  else
    warn "No OSM PBF found in ${DATA_DIR}/osm/ — skipping OSM links"
  fi

  # Link GTFS feeds into MOTIS (and OTP if region-scale)
  local gtfs_count=0
  for feed in "${DATA_DIR}/gtfs/"*.zip; do
    [ -f "$feed" ] || continue
    local feed_name
    feed_name=$(basename "$feed")

    safe_link "$feed" "${DATA_DIR}/motis/${feed_name}"
    linked=$((linked + 1))

    if [ "$planet" = false ]; then
      safe_link "$feed" "${DATA_DIR}/otp/${feed_name}"
      linked=$((linked + 1))
    fi

    gtfs_count=$((gtfs_count + 1))
  done

  if [ "$gtfs_count" -gt 0 ]; then
    if [ "$planet" = true ]; then
      ok "Linked ${gtfs_count} GTFS feed(s) into motis/"
    else
      ok "Linked ${gtfs_count} GTFS feed(s) into otp/ and motis/"
    fi
  fi

  if [ "$linked" -eq 0 ]; then
    warn "Nothing to link — download OSM and GTFS data first"
  else
    ok "Created ${linked} hardlinks (zero extra disk usage)"
  fi

  # Warn about missing data based on integration manifests
  if [ "${SELF_HOSTED_MODE:-manual}" = "auto" ] && command -v jq &>/dev/null; then
    local has_osm_data=false has_gtfs_data=false
    [ -n "$pbf" ] && has_osm_data=true
    ls "${DATA_DIR}/gtfs/"*.zip 1>/dev/null 2>&1 && has_gtfs_data=true

    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local infra_id infra_data
      infra_id=$(echo "$line" | cut -d'|' -f1)
      infra_data=$(echo "$line" | cut -d'|' -f4)
      if echo "$infra_data" | grep -q "osm-pbf" && ! $has_osm_data; then
        warn "${infra_id} requires osm-pbf but none found in ${DATA_DIR}/osm/"
        echo "    Run: ./manage.sh download-osm <region>"
      fi
      if echo "$infra_data" | grep -q "gtfs-feeds" && ! $has_gtfs_data; then
        warn "${infra_id} requires gtfs-feeds but none found in ${DATA_DIR}/gtfs/"
        echo "    Run: ./manage.sh download-all-feeds"
      fi
    done < <(discover_integration_infra)
  fi
}

# Build Service Data

cmd_build() {
  local service="${1:-}"
  if [ -z "$service" ]; then
    err "Usage: manage.sh build <valhalla|osrm|otp|motis|tiles|pelias|nominatim|photon|overpass>"
    return 1
  fi

  case "$service" in
    valhalla)  build_valhalla ;;
    osrm)      build_osrm ;;
    otp)       build_otp ;;
    motis)     build_motis ;;
    tiles)     build_tiles ;;
    pelias)    build_pelias ;;
    nominatim) build_nominatim ;;
    photon)    build_photon ;;
    overpass)  build_overpass ;;
    *)         err "Unknown service: $service"; return 1 ;;
  esac
}

cmd_build_all() {
  local pbf
  pbf=$(find_pbf)

  if [ -z "$pbf" ]; then
    err "No OSM PBF found. Run: ./manage.sh download-osm"
    return 1
  fi

  # Ensure links are up to date
  cmd_link

  log "Building all services..."

  local planet=false
  if is_planet; then
    planet=true
    warn "Planet-scale build detected"
  fi

  # In auto mode, determine which services to build from integration manifests
  if [ "${SELF_HOSTED_MODE:-manual}" = "auto" ] && command -v jq &>/dev/null; then
    log "Auto mode: reading integration manifests to determine builds..."

    # Collect needed services and profiles from manifests (respecting planetScale)
    local needed_services="" needed_profiles=""
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local id services profile ps
      id=$(echo "$line" | cut -d'|' -f1)
      profile=$(echo "$line" | cut -d'|' -f2)
      services=$(echo "$line" | cut -d'|' -f3)
      ps=$(echo "$line" | cut -d'|' -f5)

      if $planet && [ "$ps" = "false" ]; then
        warn "Skipping ${id} (not planet-scale capable)"
        continue
      fi

      [ "$services" != "--" ] && needed_services="${needed_services} ${services//,/ }"
      [ "$profile" != "--" ] && needed_profiles="${needed_profiles} ${profile}"
    done < <(discover_integration_infra)

    # Helper to check if a word is in a space-separated string
    _needs_service() { echo "$needed_services" | grep -qw "$1"; }
    _needs_profile() { echo "$needed_profiles" | grep -qw "$1"; }

    local has_gtfs=false
    ls "${DATA_DIR}/gtfs/"*.zip 1>/dev/null 2>&1 && has_gtfs=true

    # Build only needed services
    if _needs_service valhalla; then
      log "── Building valhalla ──"
      build_valhalla || warn "Valhalla build failed, continuing..."
      echo ""
    fi

    if _needs_service osrm; then
      log "── Building osrm ──"
      build_osrm || warn "OSRM build failed, continuing..."
      echo ""
    fi

    if $has_gtfs; then
      if _needs_service otp; then
        log "── Building otp ──"
        build_otp || warn "OTP build failed, continuing..."
        echo ""
      fi
      if _needs_service motis; then
        log "── Building motis ──"
        build_motis || true
        echo ""
      fi
    fi

    if _needs_profile pelias; then
      log "── Building pelias ──"
      build_pelias || warn "Pelias build failed, continuing..."
      echo ""
    fi

    if _needs_profile nominatim; then
      log "── Building nominatim ──"
      build_nominatim || warn "Nominatim build failed, continuing..."
      echo ""
    fi

    if _needs_profile photon; then
      log "── Building photon ──"
      build_photon || warn "Photon build failed, continuing..."
      echo ""
    fi

    if _needs_profile overpass; then
      log "── Building overpass ──"
      build_overpass || warn "Overpass build failed, continuing..."
      echo ""
    fi

    # Always build tiles if we have OSM data (tiles profile or not)
    log "── Building tiles ──"
    build_tiles || warn "Tile generation failed, continuing..."
    echo ""

    ok "All builds complete (auto mode)"
    return 0
  fi

  # Manual mode (default): hardcoded build order
  if $planet; then
    warn "OSRM and OTP are skipped (insufficient for planet-scale, use Valhalla and MOTIS)"
  fi

  # Always build Valhalla (handles planet well)
  log "── Building valhalla ──"
  build_valhalla || warn "Valhalla build failed, continuing..."
  echo ""

  if [ "$planet" = false ]; then
    log "── Building osrm ──"
    build_osrm || warn "OSRM build failed, continuing..."
    echo ""
  fi

  # Build transit if GTFS feeds exist
  if ls "${DATA_DIR}/gtfs/"*.zip 1>/dev/null 2>&1; then
    if [ "$planet" = false ]; then
      log "── Building otp ──"
      build_otp || warn "OTP build failed, continuing..."
      echo ""
    fi

    log "── Building motis ──"
    build_motis || true
    echo ""
  fi

  # Build tiles
  log "── Building tiles ──"
  build_tiles || warn "Tile generation failed, continuing..."
  echo ""

  # Build Nominatim (starts container which auto-imports)
  log "── Building nominatim ──"
  build_nominatim || warn "Nominatim build failed, continuing..."
  echo ""

  # Build Photon (downloads pre-built index)
  log "── Building photon ──"
  build_photon || warn "Photon build failed, continuing..."
  echo ""

  # Build Overpass (starts container which auto-imports)
  log "── Building overpass ──"
  build_overpass || warn "Overpass build failed, continuing..."
  echo ""

  ok "All builds complete"
}

build_valhalla() {
  if ! ls "${DATA_DIR}/valhalla/"*.osm.pbf 1>/dev/null 2>&1; then
    err "No OSM PBF linked for Valhalla. Run: ./manage.sh link"
    return 1
  fi

  if is_planet; then
    log "Building Valhalla routing tiles from planet PBF..."
    log "  This needs ~16 GB RAM and takes ~8 hours on a fast server."
  else
    log "Building Valhalla routing tiles..."
  fi

  log "Valhalla auto-builds tiles on startup when PBF files are present."
  log "Starting the container (set use_tiles_ignore_pbf=False to force rebuild)..."
  if ! docker compose -f "$COMPOSE_FILE" --profile routing up -d valhalla; then
    err "Failed to start Valhalla container"
    return 1
  fi
  log "Valhalla is building in the background."
  log "Monitor progress with: docker compose logs -f valhalla"
  ok "Valhalla container started (building tiles)"
}

build_osrm() {
  if [ ! -f "${DATA_DIR}/osrm/region.osm.pbf" ]; then
    err "No OSM PBF linked for OSRM. Run: ./manage.sh link"
    return 1
  fi

  if is_planet; then
    err "OSRM cannot handle planet-scale PBF (needs ~200 GB RAM)."
    err "Use Valhalla for worldwide routing instead."
    return 1
  fi

  local hash_file="${DATA_DIR}/osrm/.pbf_hash"
  local current_hash
  current_hash=$(sha256sum "${DATA_DIR}/osrm/region.osm.pbf" | cut -d' ' -f1)

  if [ -f "$hash_file" ] && [ "$(cat "$hash_file")" = "$current_hash" ] && [ -f "${DATA_DIR}/osrm/region.osrm" ]; then
    ok "OSRM data unchanged, skipping build"
    return 0
  fi

  log "Building OSRM routing data..."
  if ! docker compose -f "$COMPOSE_FILE" run --rm osrm-build; then
    err "OSRM build failed"
    return 1
  fi
  echo "$current_hash" > "$hash_file"
  ok "OSRM build complete"
}

build_otp() {
  if ! ls "${DATA_DIR}/otp/"*.osm.pbf 1>/dev/null 2>&1; then
    err "No OSM PBF linked for OTP. Run: ./manage.sh link"
    return 1
  fi

  if is_planet; then
    err "OTP cannot handle planet-scale PBF with hundreds of GTFS feeds."
    err "Use MOTIS for worldwide transit routing instead."
    return 1
  fi

  if ! ls "${DATA_DIR}/otp/"*.zip 1>/dev/null 2>&1; then
    warn "No GTFS feeds found for OTP — building with OSM only"
  fi

  log "Building OTP transit graph..."
  if ! docker compose -f "$COMPOSE_FILE" run --rm otp-build; then
    err "OTP build failed"
    return 1
  fi
  ok "OTP build complete"
}

cmd_generate_motis_config() {
  local catalog_dir="${DATA_DIR}/.transitous-catalog"

  if [ ! -d "$catalog_dir/feeds" ]; then
    err "Transitous catalog not found. Run: ./manage.sh download-all-feeds first"
    return 1
  fi

  ensure_dirs
  mkdir -p "${DATA_DIR}/.transitous-downloads"

  log "Generating MOTIS config with GTFS-RT feeds and Lua scripts..."

  # Run Transitous's generate-motis-config.py (handles RT feed matching,
  # protocol mapping, Lua script references, GBFS feeds, etc.)
  if ! docker compose -f "$COMPOSE_FILE" --profile build \
    run --rm --user "$(id -u):$(id -g)" transitous-import /run.sh generate-config; then
    err "Failed to generate MOTIS config"
    return 1
  fi

  # Copy generated config and scripts from gtfs output dir to motis dir
  if [ -f "${DATA_DIR}/gtfs/config.yml" ]; then
    cp "${DATA_DIR}/gtfs/config.yml" "${DATA_DIR}/motis/config.yml"

    # Patch config for self-hosted environment
    local config="${DATA_DIR}/motis/config.yml"
    local pbf
    pbf=$(find_pbf)

    # Fix OSM path to match our actual PBF filename
    if [ -n "$pbf" ]; then
      local pbf_name
      pbf_name=$(basename "$pbf")
      sed -i "s|^osm: .*|osm: ${pbf_name}|" "$config"
    else
      # No PBF — disable features that need it
      sed -i '/^osm:/d' "$config"
    fi

    # Disable tiles (we use TileServer GL, MOTIS tiles are for its built-in UI)
    sed -i '/^tiles:/,/^[a-z]/{ /^tiles:/d; /^  /d; }' "$config"
    # Squeeze multiple blank lines left by removed sections
    sed -i '/^$/N;/^\n$/d' "$config"

    # 90 days covers practical planning horizons without full-year import overhead
    sed -i 's|num_days: 365|num_days: 90|' "$config"

    # Remove Transitous-specific web_folder and data_attribution_link
    sed -i '/web_folder:/d' "$config"
    sed -i 's|data_attribution_link:.*|data_attribution_link: /terms#data-sources|' "$config"

    ok "Copied and patched config.yml for self-hosted environment"
  fi

  if [ -d "${DATA_DIR}/gtfs/scripts" ]; then
    mkdir -p "${DATA_DIR}/motis/scripts"
    cp -r "${DATA_DIR}/gtfs/scripts/"* "${DATA_DIR}/motis/scripts/" 2>/dev/null || true
    local lua_count
    lua_count=$(find "${DATA_DIR}/motis/scripts" -name "*.lua" 2>/dev/null | wc -l | tr -d ' ')
    ok "Copied ${lua_count} Lua import script(s) to motis/scripts/"
  fi
}

cmd_generate_api_keys() {
  require_cmd jq

  local catalog_dir="${DATA_DIR}/.transitous-catalog"
  local keys_file="${SCRIPT_DIR}/services/transitous/api-keys.json"

  if [ ! -d "$catalog_dir/feeds" ] || [ ! -d "$catalog_dir/transitland-atlas/feeds" ]; then
    err "Transitous catalog not found or Transitland Atlas missing."
    err "Run: ./manage.sh download-all-feeds first"
    return 1
  fi

  # Warn if api-keys.json already has keys
  if [ -f "$keys_file" ]; then
    local existing_keys
    existing_keys=$(jq '[to_entries[] | select(.key | startswith("_") | not) | select(.value != "")] | length' "$keys_file" 2>/dev/null || echo "0")
    if [ "$existing_keys" -gt 0 ]; then
      warn "api-keys.json already contains ${existing_keys} filled-in key(s)."
      warn "Regenerating will OVERWRITE your existing keys."
      printf "  Continue? [y/N] "
      read -r confirm
      if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        log "Aborted."
        return 0
      fi
    fi
  fi

  log "Scanning Transitous catalog for feeds requiring API keys..."

  # Scan Transitland Atlas (DMFR format) for feeds with authorization blocks
  local atlas_auth
  atlas_auth=$(find "$catalog_dir/transitland-atlas/feeds" -name "*.dmfr.json" -type f -exec \
    jq -r '.feeds[]? | select(.authorization != null) | .id' {} \; 2>/dev/null | sort -u)

  # Scan Transitous feed files for sources referencing those atlas IDs
  # Includes skipped sources — providing a key will unskip them
  local result="{}"
  local count=0

  for feed_file in "$catalog_dir/feeds/"*.json; do
    [ -f "$feed_file" ] || continue
    local region
    region=$(basename "$feed_file" .json)

    local matches
    matches=$(jq -r --arg atlas_auth "$atlas_auth" '
      .sources[]
      | select(.["transitland-atlas-id"] != null)
      | select(.["api-key"] == null)
      | select(.["url-override"] == null)
      | .name as $name | .["transitland-atlas-id"] as $id
      | if ($atlas_auth | split("\n") | index($id)) then "\($name)" else empty end
    ' "$feed_file" 2>/dev/null | sort -u)

    while IFS= read -r name; do
      [ -z "$name" ] && continue
      result=$(echo "$result" | jq --arg k "${region}/${name}" '. + {($k): ""}')
      count=$((count + 1))
    done <<< "$matches"
  done

  echo "$result" | jq -S '.' > "$keys_file"
  ok "Generated api-keys.json with ${count} entries requiring API keys"
  log "Edit ${keys_file} and fill in your keys."
  log "See api-keys.example.json for registration URLs."
}

cmd_generate_attribution() {
  local catalog_dir="${DATA_DIR}/.transitous-catalog"

  if [ ! -d "$catalog_dir/feeds" ]; then
    err "Transitous catalog not found. Run: ./manage.sh download-all-feeds first"
    return 1
  fi

  ensure_dirs
  mkdir -p "${DATA_DIR}/.transitous-downloads"

  log "Generating transit feed attribution data..."

  if ! docker compose -f "$COMPOSE_FILE" --profile build \
    run --rm --user "$(id -u):$(id -g)" transitous-import /run.sh generate-attribution; then
    err "Failed to generate attribution data"
    return 1
  fi

  # Copy attribution JSON to a location accessible by the API/web app
  if [ -f "${DATA_DIR}/gtfs/license.json" ]; then
    cp "${DATA_DIR}/gtfs/license.json" "${DATA_DIR}/motis/license.json"
    ok "Attribution data saved to data/motis/license.json"
  fi
}

build_motis() {
  if ! ls "${DATA_DIR}/motis/"*.zip 1>/dev/null 2>&1; then
    warn "No GTFS feeds linked for MOTIS"
  fi

  # Generate config with GTFS-RT mappings and attribution data
  cmd_generate_motis_config
  cmd_generate_attribution

  local feed_count
  feed_count=$(find "${DATA_DIR}/motis" -name "*.zip" -type f 2>/dev/null | wc -l | tr -d ' ')

  log "MOTIS has ${feed_count} GTFS feed(s) and will import them on startup."
  log "Start with: docker compose --profile transit up -d motis"
  ok "MOTIS ready (auto-imports on startup)"
}

build_tiles() {
  local pbf
  pbf=$(find_pbf)
  if [ -z "$pbf" ]; then
    err "No OSM PBF found. Run: ./manage.sh download-osm"
    return 1
  fi

  local pbf_name
  pbf_name=$(basename "$pbf")

  if is_planet; then
    log "Generating planet-scale vector tiles with Planetiler..."
    log "  This needs ~30 GB RAM and takes ~1 hour on a fast server."
    log "  Output will be ~80 GB MBTiles."
  else
    log "Generating vector tiles with Planetiler..."
  fi

  if ! docker run --rm \
    -e JAVA_TOOL_OPTIONS="-Xmx30g" \
    -v "${DATA_DIR}/osm:/osm:ro" \
    -v "${DATA_DIR}/tileserver:/output" \
    ghcr.io/onthegomap/planetiler:latest \
    --download \
    --osm-path="/osm/${pbf_name}" \
    --output="/output/tiles.mbtiles" \
    --nodemap-type=array \
    --force; then
    err "Tile generation failed"
    return 1
  fi
  ok "Tile generation complete: data/tileserver/tiles.mbtiles"
}

build_pelias() {
  if [ ! -f "${DATA_DIR}/pelias/openstreetmap/data.osm.pbf" ]; then
    err "No OSM PBF linked for Pelias. Run: ./manage.sh link"
    return 1
  fi

  log "Building Pelias geocoding index..."
  log "This starts Elasticsearch, creates the schema, downloads Who's on First"
  log "data, and imports both WOF and OSM. Takes 1-8 hours for planet."

  # Start Elasticsearch
  log "Starting Elasticsearch..."
  if ! docker compose -f "$COMPOSE_FILE" --profile pelias up -d elasticsearch; then
    err "Failed to start Elasticsearch"
    return 1
  fi
  log "Waiting for Elasticsearch to be ready..."
  local retries=0
  while ! docker compose -f "$COMPOSE_FILE" exec elasticsearch curl -fs http://localhost:9200/_cluster/health &>/dev/null; do
    retries=$((retries + 1))
    if [ "$retries" -gt 60 ]; then
      err "Elasticsearch failed to start after 5 minutes"
      return 1
    fi
    sleep 5
  done
  ok "Elasticsearch ready"

  # Create schema
  log "Creating Pelias schema..."
  if ! docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-schema; then
    err "Pelias schema creation failed"
    return 1
  fi
  ok "Schema created"

  # Download and import Who's on First
  log "Downloading and importing Who's on First administrative data..."
  if ! docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-whosonfirst-import; then
    err "Who's on First import failed"
    return 1
  fi
  ok "Who's on First import complete"

  # Import OpenStreetMap
  log "Importing OpenStreetMap data..."
  if ! docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-openstreetmap-import; then
    err "OpenStreetMap import failed"
    return 1
  fi
  ok "OpenStreetMap import complete"

  # Build placeholder
  log "Building placeholder (coarse geocoding) data..."
  if ! docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-placeholder-build; then
    err "Placeholder build failed"
    return 1
  fi
  ok "Placeholder build complete"

  ok "Pelias geocoding index built. Start with: docker compose --profile pelias up -d"
}

build_nominatim() {
  if [ ! -f "${DATA_DIR}/nominatim/data.osm.pbf" ]; then
    err "No OSM PBF linked for Nominatim. Run: ./manage.sh link"
    return 1
  fi

  if is_planet; then
    log "Starting Nominatim planet import..."
    log "  This needs ~64 GB RAM (peak) and takes ~48 hours on a fast server."
    log "  After import, runtime needs ~2 GB RAM and ~1 TB disk."
  else
    log "Starting Nominatim import..."
  fi

  log "Nominatim auto-imports on first start. Starting the container..."
  if ! docker compose -f "$COMPOSE_FILE" --profile nominatim up -d nominatim; then
    err "Failed to start Nominatim container"
    return 1
  fi
  log "Nominatim is importing in the background."
  log "Monitor progress with: docker compose logs -f nominatim"
  log "Import is complete when you see 'Using project directory: /nominatim'"
  ok "Nominatim container started (importing)"
}

build_photon() {
  ensure_dirs

  log "Starting Photon geocoder..."
  log "  On first start, it auto-downloads the worldwide search index (~200 GB)."
  log "  This can take several hours depending on bandwidth."
  log "  Subsequent starts use the cached index."

  if ! docker compose -f "$COMPOSE_FILE" --profile photon up -d photon; then
    err "Failed to start Photon container"
    return 1
  fi
  log "Photon is downloading its index in the background."
  log "Monitor progress with: docker compose logs -f photon"
  ok "Photon container started"
}

build_overpass() {
  if [ ! -f "${DATA_DIR}/overpass/osm/data.osm.bz2" ]; then
    err "No bz2 found for Overpass. Run: ./manage.sh convert-overpass"
    return 1
  fi

  if is_planet; then
    log "Starting Overpass API planet import..."
    log "  This takes ~24 hours and needs ~200 GB disk."
  else
    log "Starting Overpass API import..."
  fi

  log "Overpass auto-imports on first start. Starting the container..."
  if ! docker compose -f "$COMPOSE_FILE" --profile overpass up -d overpass; then
    err "Failed to start Overpass container"
    return 1
  fi
  log "Overpass is importing in the background."
  log "Monitor progress with: docker compose logs -f overpass"
  ok "Overpass container started (importing)"
}

# Service Management

cmd_start() {
  if [ $# -eq 0 ]; then
    err "Usage: manage.sh start <service|profile|all|auto> [...]"
    err ""
    err "Services: postgis redis traefik api web valhalla osrm motis otp"
    err "          elasticsearch pelias-api nominatim photon overpass tileserver martin"
    err "Profiles: core proxy app routing transit pelias nominatim photon overpass tiles martin"
    err "      all  — start core + all profiles"
    err "      auto — start profiles needed by enabled integrations (requires SELF_HOSTED_MODE=auto)"
    return 1
  fi

  # Handle "start auto" — resolve profiles from integration manifests
  if [ "$1" = "auto" ]; then
    if [ "${SELF_HOSTED_MODE:-manual}" != "auto" ]; then
      err "SELF_HOSTED_MODE is not set to 'auto' in data.conf"
      err "Set SELF_HOSTED_MODE=auto to enable manifest-based profile resolution"
      return 1
    fi

    require_cmd jq

    local planet=false
    is_planet && planet=true

    _PROFILES=()
    _SERVICES=()

    local started_profiles=""
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local id profile services ps
      id=$(echo "$line" | cut -d'|' -f1)
      profile=$(echo "$line" | cut -d'|' -f2)
      services=$(echo "$line" | cut -d'|' -f3)
      ps=$(echo "$line" | cut -d'|' -f5)

      [ "$profile" = "--" ] && continue

      # Skip non-planet-capable integrations on planet data
      if $planet && [ "$ps" = "false" ]; then
        warn "Skipping ${id} (not planet-scale capable)"
        continue
      fi

      # Deduplicate profiles (needed to activate profile-scoped services)
      local dup=false
      if [ ${#_PROFILES[@]} -gt 0 ]; then
        for p in "${_PROFILES[@]}"; do [ "$p" = "$profile" ] && dup=true; done
      fi
      if ! $dup; then
        _PROFILES+=("$profile")
        started_profiles="${started_profiles:+$started_profiles, }${profile}"
      fi

      # Collect individual service names to start only what's declared
      [ "$services" = "--" ] && continue
      for svc in $(echo "$services" | tr ',' ' '); do
        local svc_dup=false
        if [ ${#_SERVICES[@]} -gt 0 ]; then
          for s in "${_SERVICES[@]}"; do [ "$s" = "$svc" ] && svc_dup=true; done
        fi
        $svc_dup || _SERVICES+=("$svc")
      done
    done < <(discover_integration_infra)

    if [ ${#_PROFILES[@]} -eq 0 ]; then
      warn "No profiles to start based on enabled integrations"
      return 0
    fi

    local cmd
    cmd=$(compose_with_profiles)
    log "Auto-starting profiles: ${started_profiles}"
    log "Services: ${_SERVICES[*]}"
    $cmd up -d "${_SERVICES[@]}"
    ok "Started profiles: ${started_profiles}"
    return 0
  fi

  resolve_targets "$@"
  local cmd
  cmd=$(compose_with_profiles)

  log "Starting: $*"
  $cmd up -d "${_SERVICES[@]}"
  ok "Started: $*"
}

cmd_stop() {
  if [ $# -eq 0 ]; then
    err "Usage: manage.sh stop <service|profile|all> [...]"
    return 1
  fi

  resolve_targets "$@"

  # For stop, expand profiles to service names so compose can find them
  # without needing --profile flags (containers are already running)
  local services=("${_SERVICES[@]}")
  if [ "$1" = "all" ]; then
    # Stop all compose services
    log "Stopping all services..."
    docker compose -f "$COMPOSE_FILE" stop
    ok "All services stopped"
    return 0
  fi

  for p in "${_PROFILES[@]}"; do
    for svc in $(profile_to_services "$p"); do
      local dup=false
      for s in "${services[@]}"; do [ "$s" = "$svc" ] && dup=true; done
      $dup || services+=("$svc")
    done
  done

  log "Stopping: $*"
  docker compose -f "$COMPOSE_FILE" stop "${services[@]}"
  ok "Stopped: $*"
}

cmd_restart() {
  if [ $# -eq 0 ]; then
    err "Usage: manage.sh restart <service|profile|all> [...]"
    return 1
  fi

  resolve_targets "$@"
  local cmd
  cmd=$(compose_with_profiles)

  # Use stop + up -d to ensure containers are started even if they weren't running
  log "Restarting: $*"

  # Stop first (expand profiles to service names for stop)
  local services=("${_SERVICES[@]}")
  for p in "${_PROFILES[@]}"; do
    for svc in $(profile_to_services "$p"); do
      local dup=false
      for s in "${services[@]}"; do [ "$s" = "$svc" ] && dup=true; done
      $dup || services+=("$svc")
    done
  done

  if [ ${#services[@]} -gt 0 ]; then
    docker compose -f "$COMPOSE_FILE" stop "${services[@]}" 2>/dev/null || true
  fi

  $cmd up -d "${_SERVICES[@]}"
  ok "Restarted: $*"
}

cmd_recreate() {
  if [ $# -eq 0 ]; then
    err "Usage: manage.sh recreate <service|profile|all> [...]"
    return 1
  fi

  resolve_targets "$@"
  local cmd
  cmd=$(compose_with_profiles)

  log "Recreating: $* (pull + force-recreate)"
  $cmd pull "${_SERVICES[@]}" 2>/dev/null || warn "Some images could not be pulled (local builds?)"
  $cmd up -d --force-recreate "${_SERVICES[@]}"
  ok "Recreated: $*"
}

cmd_down() {
  if [ $# -eq 0 ]; then
    log "Stopping and removing all containers..."
    local profile_args=""
    for p in "${ALL_PROFILES[@]}"; do
      profile_args+=" --profile $p"
    done
    docker compose -f "$COMPOSE_FILE" $profile_args down
    ok "All containers stopped and removed"
    return 0
  fi

  resolve_targets "$@"

  # Expand profiles to service names
  local services=("${_SERVICES[@]}")
  for p in "${_PROFILES[@]}"; do
    for svc in $(profile_to_services "$p"); do
      local dup=false
      for s in "${services[@]}"; do [ "$s" = "$svc" ] && dup=true; done
      $dup || services+=("$svc")
    done
  done

  log "Stopping and removing: $*"
  docker compose -f "$COMPOSE_FILE" rm -sf "${services[@]}"
  ok "Removed: $*"
}

cmd_logs() {
  if [ $# -eq 0 ]; then
    err "Usage: manage.sh logs <service> [--tail N]"
    err "  Follows logs by default. Press Ctrl+C to stop."
    return 1
  fi

  local service="$1"
  shift

  if ! is_service "$service"; then
    err "Unknown service: $service"
    return 1
  fi

  docker compose -f "$COMPOSE_FILE" logs -f "$@" "$service"
}

cmd_pull() {
  if [ $# -eq 0 ]; then
    log "Pulling latest images for all profiles..."
    local profile_args=""
    for p in "${ALL_PROFILES[@]}"; do
      profile_args+=" --profile $p"
    done
    docker compose -f "$COMPOSE_FILE" $profile_args pull
    ok "All images pulled"
    return 0
  fi

  resolve_targets "$@"
  local cmd
  cmd=$(compose_with_profiles)

  log "Pulling: $*"
  $cmd pull "${_SERVICES[@]}"
  ok "Pulled: $*"
}

cmd_ps() {
  local profile_args=""
  for p in "${ALL_PROFILES[@]}"; do
    profile_args+=" --profile $p"
  done
  docker compose -f "$COMPOSE_FILE" $profile_args ps "$@"
}

# Status

cmd_status() {
  ensure_dirs

  echo ""
  log "=== OpenMapX Data Status ==="
  echo ""

  # Config
  _bold "Configuration:"
  echo "  Region: ${REGION}"
  echo "  Data dir: ${DATA_DIR}"
  echo ""

  # OSM PBF
  _bold "OSM Data (data/osm/):"
  local pbf_count=0
  for f in "${DATA_DIR}/osm/"*.osm.pbf; do
    [ -f "$f" ] || continue
    local sz
    sz=$(file_size "$f")
    echo "  $(basename "$f")  $(human_size "$sz")"
    if [ "$sz" -gt 50000000000 ]; then
      echo "    ^ Planet-scale (OSRM/OTP disabled, using Valhalla/MOTIS)"
    fi
    pbf_count=$((pbf_count + 1))
  done
  [ "$pbf_count" -eq 0 ] && echo "  (none — run: ./manage.sh download-osm)"

  # GTFS Feeds
  echo ""
  _bold "GTFS Feeds (data/gtfs/):"
  local gtfs_count=0
  local gtfs_total_bytes=0
  for f in "${DATA_DIR}/gtfs/"*.zip; do
    [ -f "$f" ] || continue
    gtfs_count=$((gtfs_count + 1))
    local sz
    sz=$(file_size "$f")
    gtfs_total_bytes=$((gtfs_total_bytes + sz))
  done
  if [ "$gtfs_count" -gt 0 ]; then
    echo "  ${gtfs_count} feeds, $(human_size "$gtfs_total_bytes") total"
    # Show first 10 and count
    local shown=0
    for f in "${DATA_DIR}/gtfs/"*.zip; do
      [ -f "$f" ] || continue
      shown=$((shown + 1))
      [ "$shown" -gt 10 ] && break
      echo "    $(basename "$f")  $(human_size "$(file_size "$f")")"
    done
    if [ "$gtfs_count" -gt 10 ]; then
      echo "    ... and $((gtfs_count - 10)) more"
    fi
  else
    echo "  (none — run: ./manage.sh download-all-feeds)"
  fi

  # Service workspaces
  echo ""
  _bold "Service Workspaces:"
  for svc in valhalla osrm otp motis tileserver pelias nominatim photon overpass; do
    local dir="${DATA_DIR}/${svc}"
    if [ -d "$dir" ]; then
      local count
      count=$(find "$dir" -type f 2>/dev/null | wc -l | tr -d ' ')
      local size
      size=$(du -sh "$dir" 2>/dev/null | cut -f1 || echo "0")
      echo "  ${svc}: ${count} files, ${size}"
    fi
  done

  # Disk usage
  echo ""
  _bold "Disk Usage:"
  for sub in osm gtfs osrm valhalla otp motis tileserver pelias nominatim photon overpass; do
    local dir="${DATA_DIR}/${sub}"
    if [ -d "$dir" ]; then
      local size
      size=$(du -sh "$dir" 2>/dev/null | cut -f1 || echo "0")
      printf "  %-14s %s\n" "${sub}/" "$size"
    fi
  done
  du -sh "${DATA_DIR}" 2>/dev/null | awk '{printf "  %-14s %s\n", "TOTAL", $1}'

  # Docker volumes (not in data/)
  echo ""
  _bold "Docker Volumes:"
  local vol_total=0
  local has_volumes=false
  while IFS=$'\t' read -r vol_name vol_size; do
    [ -z "$vol_name" ] && continue
    has_volumes=true
    printf "  %-30s %s\n" "$vol_name" "$vol_size"
  done < <(docker volume ls -q 2>/dev/null | while read -r vol; do
    local size
    size=$(docker system df -v 2>/dev/null | grep "^$vol" | awk '{print $NF}' || echo "?")
    [ -z "$size" ] && size="?"
    echo -e "${vol}\t${size}"
  done)
  if [ "$has_volumes" = false ]; then
    echo "  (none)"
  fi

  # Docker images and build cache
  echo ""
  _bold "Docker Storage:"
  docker system df --format '  {{.Type}}: {{.Size}} (reclaimable: {{.Reclaimable}})' 2>/dev/null || echo "  (docker not available)"

  # Running containers
  echo ""
  _bold "Running Containers:"
  local container_count=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    echo "  $line"
    container_count=$((container_count + 1))
  done < <(docker ps --format '{{.Names}}  {{.Status}}  {{.Image}}' 2>/dev/null)
  [ "$container_count" -eq 0 ] && echo "  (none)"

  # Overall disk
  echo ""
  _bold "System Disk:"
  df -h / 2>/dev/null | tail -1 | awk '{printf "  Total: %s  Used: %s  Free: %s  (%s)\n", $2, $3, $4, $5}'
  echo ""

  # Resource requirements
  if is_planet 2>/dev/null; then
    _bold "Planet-Scale Resource Requirements:"
    echo "  Valhalla build:   ~16 GB RAM, ~8 hours"
    echo "  Planetiler tiles: ~30 GB RAM, ~1 hour"
    echo "  MOTIS import:     ~8 GB RAM, ~30 min per 100 feeds"
    echo "  OSRM:             DISABLED (needs ~200 GB RAM)"
    echo "  OTP:              DISABLED (needs ~100 GB RAM)"
    echo ""
  fi
}

# Health Check

cmd_check() {
  echo ""
  log "=== Service Health Check ==="
  echo ""

  local passed=0
  local failed=0
  local skipped=0

  _pass()      { printf '\033[0;32m%s\033[0m' "OK"; }
  _fail()      { printf '\033[0;31m%s\033[0m' "FAILED"; }
  _skip()      { printf '\033[1;33m%s\033[0m' "SKIPPED"; }
  _importing() { printf '\033[1;33m%s\033[0m' "IMPORTING"; }

  is_running() {
    docker compose ps --format '{{.Name}}' 2>/dev/null | grep -qi "$1"
  }

  check_http() {
    local name="$1" url="$2" expect="$3"
    if ! is_running "$name"; then
      printf "  %-14s %s\n" "$name" "$(_skip) (not running)"
      skipped=$((skipped + 1))
      return
    fi
    local response
    response=$(curl -sf --max-time 10 "$url" 2>/dev/null || echo "")
    if [ -n "$response" ] && ([ -z "$expect" ] || echo "$response" | grep -qi "$expect"); then
      printf "  %-14s %s\n" "$name" "$(_pass)"
      passed=$((passed + 1))
    elif docker compose ps 2>/dev/null | grep -i "$name" | grep -qi "starting\|Restarting\|unhealthy"; then
      printf "  %-14s %s\n" "$name" "$(_importing)"
      skipped=$((skipped + 1))
    else
      printf "  %-14s %s\n" "$name" "$(_fail)"
      failed=$((failed + 1))
    fi
  }

  check_docker() {
    local name="$1" cmd="$2" expect="$3"
    if ! is_running "$name"; then
      printf "  %-14s %s\n" "$name" "$(_skip) (not running)"
      skipped=$((skipped + 1))
      return
    fi
    local response
    response=$(docker compose exec -T "$name" sh -c "$cmd" 2>/dev/null || echo "")
    if echo "$response" | grep -qi "$expect"; then
      printf "  %-14s %s\n" "$name" "$(_pass)"
      passed=$((passed + 1))
    else
      printf "  %-14s %s\n" "$name" "$(_fail)"
      failed=$((failed + 1))
    fi
  }

  check_overpass() {
    local name="$1"
    if ! is_running "$name"; then
      printf "  %-14s %s\n" "$name" "$(_skip) (not running)"
      skipped=$((skipped + 1))
      return
    fi
    local response
    response=$(curl -sf --max-time 10 -G --data-urlencode 'data=[out:json];node(1);out;' "http://localhost:8082/api/interpreter" 2>/dev/null || echo "")
    if echo "$response" | grep -qi "elements"; then
      printf "  %-14s %s\n" "$name" "$(_pass)"
      passed=$((passed + 1))
    elif docker compose ps 2>/dev/null | grep -i "$name" | grep -qi "starting\|Restarting\|unhealthy"; then
      printf "  %-14s %s\n" "$name" "$(_importing)"
      skipped=$((skipped + 1))
    else
      printf "  %-14s %s\n" "$name" "$(_fail)"
      failed=$((failed + 1))
    fi
  }

  _bold "Infrastructure:"
  check_docker "postgis" "pg_isready -U postgres" "accepting"
  check_docker "redis" "redis-cli ping" "PONG"

  echo ""
  _bold "Routing:"
  check_http "valhalla" "http://localhost:8002/status" "tileset_last_modified"
  check_http "osrm" "http://localhost:5000/nearest/v1/driving/13.405,52.52" "waypoints"

  echo ""
  _bold "Transit:"
  check_http "motis" "http://localhost:8081/api/v1/geocode?text=test" "name"
  check_http "otp" "http://localhost:8090/otp/routers" ""

  echo ""
  _bold "Geocoding:"
  check_http "nominatim" "http://localhost:8088/status" ""
  check_http "photon" "http://localhost:2322/api?q=test" "features"

  echo ""
  _bold "Data Services:"
  check_overpass "overpass"
  check_http "tileserver" "http://localhost:8080/health" ""

  echo ""
  _bold "Application:"
  check_docker "api" "wget -qO- --timeout=5 http://localhost:3001/health 2>/dev/null || curl -sf http://localhost:3001/health" ""
  check_docker "web" "wget -qO- --timeout=5 http://localhost:3000 2>/dev/null || curl -sf http://localhost:3000" ""
  check_http "traefik" "http://localhost:80" ""

  echo ""
  printf "  Passed: %d  Failed: %d  Skipped: %d\n" "$passed" "$failed" "$skipped"
  echo ""

  if [ "$failed" -gt 0 ]; then
    warn "Some services are not healthy. Check logs with: docker compose logs <service>"
  fi
}

# Update

cmd_update() {
  log "Updating all data..."
  cmd_download_osm
  cmd_download_all_feeds
  cmd_download_style
  cmd_link
  cmd_build_all
  ok "Update complete"
}

# Clean

cmd_clean() {
  local target="${1:-}"

  if [ -z "$target" ]; then
    err "Usage: manage.sh clean <valhalla|osrm|otp|motis|tiles|pelias|nominatim|photon|overpass|styles|feeds|compiled|all>"
    return 1
  fi

  case "$target" in
    osrm)
      rm -rf "${DATA_DIR:?}/osrm/"*
      ok "Cleaned OSRM compiled data"
      ;;
    valhalla)
      rm -rf "${DATA_DIR:?}/valhalla/"*
      ok "Cleaned Valhalla tiles"
      ;;
    otp)
      rm -f "${DATA_DIR}/otp/graph.obj" "${DATA_DIR}/otp/"*.graph.obj
      rm -rf "${DATA_DIR}/otp/graph-cache"
      ok "Cleaned OTP graph"
      ;;
    motis)
      rm -rf "${DATA_DIR}/motis/data"
      ok "Cleaned MOTIS compiled data"
      ;;
    tiles)
      rm -f "${DATA_DIR}/tileserver/"*.mbtiles
      ok "Cleaned generated tiles"
      ;;
    pelias)
      rm -rf "${DATA_DIR}/pelias/whosonfirst" "${DATA_DIR}/pelias/placeholder"
      rm -f "${DATA_DIR}/pelias/openstreetmap/data.osm.pbf"
      ok "Cleaned Pelias data (Elasticsearch index preserved in Docker volume)"
      ;;
    nominatim)
      rm -f "${DATA_DIR}/nominatim/data.osm.pbf"
      ok "Cleaned Nominatim data (database preserved in Docker volume)"
      warn "To fully reset: docker volume rm openmapx_nominatim-data"
      ;;
    photon)
      rm -rf "${DATA_DIR}/photon/"*
      ok "Cleaned Photon search index"
      ;;
    overpass)
      rm -rf "${DATA_DIR}/overpass/db/"*
      rm -f "${DATA_DIR}/overpass/osm/data.osm.pbf" "${DATA_DIR}/overpass/osm/data.osm.bz2"
      ok "Cleaned Overpass database"
      ;;
    styles)
      rm -rf "${DATA_DIR}/tileserver/fonts" "${DATA_DIR}/tileserver/sprites" "${DATA_DIR}/tileserver/styles"
      ok "Cleaned map styles, fonts, and sprites"
      ;;
    feeds)
      rm -f "${DATA_DIR}/gtfs/"*.zip
      rm -rf "${DATA_DIR}/.transitous-catalog"
      rm -f "${DATA_DIR}/.feed-urls.txt"
      ok "Cleaned all GTFS feeds and catalog cache"
      ;;
    compiled)
      cmd_clean osrm
      cmd_clean valhalla
      cmd_clean otp
      cmd_clean motis
      cmd_clean tiles
      cmd_clean pelias
      cmd_clean nominatim
      cmd_clean photon
      cmd_clean overpass
      cmd_clean styles
      ;;
    all)
      rm -rf "${DATA_DIR:?}"
      ok "Removed all data (${DATA_DIR})"
      ;;
    *)
      err "Unknown target: $target"
      return 1
      ;;
  esac
}

# Help

cmd_help() {
  cat <<'HELP'
OpenMapX Infrastructure Manager

Central CLI for the OpenMapX self-hosted stack. Handles the full lifecycle:
download source data (OSM, GTFS, map styles), build service indexes, and
start/stop/restart/monitor the 15+ Docker Compose services that make up
routing, transit, geocoding, tile serving, and the application layer.

DATA COMMANDS:
  download-osm [region]       Download OSM PBF from Geofabrik
                               Use "planet" for worldwide (~70 GB).
                               Default region from data.conf.
                               Regions: https://download.geofabrik.de/
                               Auto-converts PBF → bz2 for Overpass.

  convert-overpass             Convert OSM PBF → bz2 for Overpass
                               Runs automatically after download-osm.
                               Requires: osmium-tool (apt install osmium-tool)

  add-feed <url> [slug]       Download a single GTFS feed

  download-all-feeds [cc]     Download GTFS feeds via Transitous pipeline
                               Resolves Transitland/MDB references,
                               validates, and cleans feeds with gtfsclean.
                               Optional: 2-letter country code filter (e.g. de)
                               Comma-separated for multiple (e.g. de,at,ch)

  remove-feed <slug>          Remove a GTFS feed and its links

  download-style              Download map styles, fonts, and sprites
                               OSM Bright, OSM Liberty, Positron, Dark Matter
                               + OpenMapTiles font glyphs for label rendering

  link                        Hard-link source data into service directories
                               Detects planet-scale and skips OSRM/OTP.

BUILD COMMANDS:
  build <service>             Build data for a service:
                               valhalla  - Routing tiles + elevation
                               osrm      - Routing graph (region-only)
                               otp       - Transit graph (region-only)
                               motis     - Auto-builds on container start
                               tiles     - Vector MBTiles via Planetiler
                               pelias    - Geocoding index (ES + WOF + OSM)
                               nominatim - Geocoder (auto-imports on start)
                               photon    - Download pre-built search index
                               overpass  - OSM query API (auto-imports)

  build-all                   Build all applicable services

  generate-motis-config       Generate MOTIS config.yml with GTFS-RT feeds
                               Uses Transitous's config generator for RT
                               feed matching, Lua scripts, and GBFS feeds.
                               Auto-run by 'build motis'.

  generate-api-keys           Generate api-keys.json from Transitous catalog
                               Scans for feeds requiring API keys and creates
                               a template to fill in. Warns before overwriting.

  generate-attribution        Generate transit feed attribution/license data
                               Extracts publisher, operator, and license info
                               from GTFS feeds. Output: data/motis/license.json
                               Auto-run by 'build motis'.

SERVICE MANAGEMENT:
  start <target> [...]        Start services or profiles
  stop <target> [...]         Stop services or profiles
  restart <target> [...]      Restart services or profiles (stop + start)
  recreate <target> [...]     Pull latest images and force-recreate containers
  down [target...]            Stop and remove containers (default: all)
  logs <service> [--tail N]   Follow logs for a service (Ctrl+C to stop)
  pull [target...]            Pull latest images (default: all)
  ps                          Show container status for all services

INTEGRATION DISCOVERY:
  integrations [options]      Show integrations with infrastructure declarations
                               --profile <name>  Filter by Docker profile
                               --data <type>     Filter by data requirement
                               --json            Machine-readable JSON output

  profiles                    Show Docker profiles needed by enabled integrations
                               Groups integrations by profile, builds start command.
                               Respects planet-scale (skips non-capable).

  check-data                  Check data requirements vs available data
                               Shows osm-pbf/gtfs-feeds status for each
                               integration that needs them.

MONITORING:
  status                      Show data inventory, disk usage, and containers
  check                       Health-check all running services
                               Tests HTTP endpoints, DB connections,
                               and reports pass/fail/skip for each.

MAINTENANCE:
  update                      Re-download all data and rebuild everything

  clean <target>              Remove data:
                               valhalla|osrm|otp|motis|tiles|pelias
                               nominatim|photon|overpass|styles
                               feeds    - all GTFS feeds
                               compiled - all compiled, keep sources
                               all      - everything

TARGETS (for start/stop/restart/recreate/down/pull):
  Services:  postgis redis traefik api web valhalla osrm motis otp
             elasticsearch pelias-api pelias-placeholder pelias-pip
             nominatim photon overpass tileserver martin
  Profiles:  core (postgis+redis)  proxy  app  routing  transit
             pelias  nominatim  photon  overpass  tiles  martin
  Special:   all  — all profiles + core
             auto — profiles from enabled integration manifests (requires SELF_HOSTED_MODE=auto)
  Multiple targets can be combined: ./manage.sh start routing transit nominatim

SERVICES:
  Routing     Valhalla (planet-capable), OSRM (region-only)
  Transit     MOTIS (planet-capable), OTP (region-only)
  Geocoding   Pelias (ES-based), Nominatim (full OSM), Photon (lightweight)
  OSM Query   Overpass API (transit stops, POIs, trails)
  Map Tiles   Planetiler (vector MBTiles) + TileServer GL (styles)
  Elevation   Valhalla (SRTM data, auto-downloaded during build)
  Database    PostgreSQL + PostGIS, Redis, Elasticsearch
  App         Fastify API + Next.js Web, Traefik reverse proxy

PLANET-SCALE NOTES:
  When using planet PBF (~70 GB), the manager automatically:
  - Skips OSRM (needs ~200 GB RAM) → use Valhalla instead
  - Skips OTP (needs ~100 GB RAM)  → use MOTIS instead
  - Builds Valhalla with elevation (~16 GB RAM, ~8 hours)
  - Builds Planetiler tiles (~30 GB RAM, ~1 hour, ~80 GB output)
  - Starts Nominatim import (~64 GB RAM peak, ~48 hours)
  - Downloads Photon index (~75 GB compressed)
  - Starts Overpass import (~24 hours, ~200 GB disk)
  - Links GTFS feeds to MOTIS only (not OTP)
  - Recommended: 64+ GB RAM, 2+ TB SSD

EXAMPLES:
  # Full worldwide self-hosted setup
  ./manage.sh download-osm planet
  ./manage.sh download-all-feeds
  ./manage.sh download-style
  ./manage.sh link && ./manage.sh build-all
  ./manage.sh start all

  # Single country (lighter)
  ./manage.sh download-osm europe/germany
  ./manage.sh download-all-feeds de
  ./manage.sh download-style
  ./manage.sh link && ./manage.sh build-all
  ./manage.sh start routing transit nominatim tiles

  # Just routing + tiles (minimal)
  ./manage.sh download-osm europe/germany
  ./manage.sh download-style
  ./manage.sh link
  ./manage.sh build valhalla && ./manage.sh build tiles
  ./manage.sh start routing tiles

  # Auto mode (reads integration manifests)
  # Set SELF_HOSTED_MODE=auto in data.conf first
  ./manage.sh integrations               # see what's declared
  ./manage.sh profiles                   # see which profiles are needed
  ./manage.sh check-data                 # verify data is available
  ./manage.sh start auto                 # start exactly what's needed

  # Day-to-day operations
  ./manage.sh restart motis              # restart a single service
  ./manage.sh recreate transit           # pull + recreate a whole profile
  ./manage.sh logs valhalla              # follow logs
  ./manage.sh stop routing               # stop all routing services
  ./manage.sh ps                         # overview of running containers
  ./manage.sh check                      # health-check everything

  # Weekly update (cron-friendly)
  0 3 * * 0 cd /path/to/infra/docker && ./manage.sh update

ENVIRONMENT:
  DATA_DIR                  Data directory (default: ./data)
  REGION                    Default OSM region (default from data.conf)
  MAX_CONCURRENT_DOWNLOADS  Parallel feed downloads (default: 5)
  NOMINATIM_THREADS         Nominatim import threads (default: 8)
  SELF_HOSTED_MODE          "auto" or "manual" (default: manual from data.conf)
  DISABLED_INTEGRATIONS     Space-separated integration IDs to exclude

HELP
}

# Main

main() {
  case "${1:-help}" in
    download-osm)            shift; cmd_download_osm "$@" ;;
    convert-overpass)        cmd_convert_overpass ;;
    add-feed|download-gtfs)  shift; cmd_download_gtfs "$@" ;;
    download-all-feeds)      shift; cmd_download_all_feeds "$@" ;;
    remove-feed)             shift; cmd_remove_feed "$@" ;;
    download-style)          cmd_download_style ;;
    generate-motis-config)   cmd_generate_motis_config ;;
    generate-api-keys)       cmd_generate_api_keys ;;
    generate-attribution)    cmd_generate_attribution ;;
    link)                    cmd_link ;;
    build)                   shift; cmd_build "$@" ;;
    build-all)               cmd_build_all ;;
    start|up)                shift; cmd_start "$@" ;;
    stop)                    shift; cmd_stop "$@" ;;
    restart)                 shift; cmd_restart "$@" ;;
    recreate)                shift; cmd_recreate "$@" ;;
    down)                    shift; cmd_down "$@" ;;
    logs)                    shift; cmd_logs "$@" ;;
    pull)                    shift; cmd_pull "$@" ;;
    ps)                      shift; cmd_ps "$@" ;;
    integrations)            shift; cmd_integrations "$@" ;;
    profiles)                cmd_profiles ;;
    check-data)              cmd_check_data ;;
    status)                  cmd_status ;;
    check)                   cmd_check ;;
    update)                  cmd_update ;;
    clean)                   shift; cmd_clean "$@" ;;
    help|--help|-h)          cmd_help ;;
    *)                       err "Unknown command: $1"; echo ""; cmd_help; exit 1 ;;
  esac
}

main "$@"
