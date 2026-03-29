#!/usr/bin/env bash
set -euo pipefail

# ── OpenMapX Data Manager ────────────────────────────────────────────────
# Manages OSM and GTFS data for all self-hosted services.
# Downloads source data once and hardlinks it into each service's workspace,
# so multiple services share the same files with zero extra storage.
#
# Requirements: curl, jq, docker (with compose plugin)
# ─────────────────────────────────────────────────────────────────────────

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

# ── Helpers ──────────────────────────────────────────────────────────────

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

ensure_dirs() {
  mkdir -p \
    "${DATA_DIR}/osm" \
    "${DATA_DIR}/gtfs" \
    "${DATA_DIR}/osrm" \
    "${DATA_DIR}/valhalla" \
    "${DATA_DIR}/otp" \
    "${DATA_DIR}/otp/osm" \
    "${DATA_DIR}/otp/gtfs" \
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

# ── Download OSM PBF ─────────────────────────────────────────────────────

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

# ── Download GTFS Feeds ──────────────────────────────────────────────────

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
    run --rm transitous-import /run.sh fetch "$country_filter"; then
    warn "Some feeds failed to download — check output above"
  fi

  # Show total GTFS size
  local feed_count
  feed_count=$(find "${DATA_DIR}/gtfs" -name "*.gtfs.zip" -o -name "*.netex.zip" 2>/dev/null | wc -l | tr -d ' ')
  local gtfs_size
  gtfs_size=$(du -sh "${DATA_DIR}/gtfs" 2>/dev/null | cut -f1 || echo "0")
  ok "GTFS feeds: ${feed_count} feeds, ${gtfs_size} total"
}

# ── Download Map Style, Fonts, Sprites ─────────────────────────────────

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

# ── Remove GTFS Feed ────────────────────────────────────────────────────

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

# ── Link Source Data into Service Directories ────────────────────────────

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
      safe_link "$pbf" "${DATA_DIR}/otp/osm/${pbf_name}" && ok "  -> otp/osm/${pbf_name}"
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
      safe_link "$feed" "${DATA_DIR}/otp/gtfs/${feed_name}"
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
}

# ── Build Service Data ───────────────────────────────────────────────────

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
    warn "Planet-scale build — only building Valhalla, MOTIS, and tiles"
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
    run --rm transitous-import /run.sh generate-config; then
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
    run --rm transitous-import /run.sh generate-attribution; then
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

# ── Status ───────────────────────────────────────────────────────────────

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
  echo "  ──────────────────"
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

# ── Health Check ─────────────────────────────────────────────────────────

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
    elif docker compose ps 2>/dev/null | grep -i "$name" | grep -qi "starting\|Restarting"; then
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

  _bold "Infrastructure:"
  check_docker "postgis" "pg_isready -U postgres" "accepting"
  check_docker "redis" "redis-cli ping" "PONG"

  echo ""
  _bold "Routing:"
  check_http "valhalla" "http://localhost:8002/status" "tileset_last_modified"
  check_http "osrm" "http://localhost:5000/nearest/v1/driving/13.405,52.52" "waypoints"

  echo ""
  _bold "Transit:"
  check_http "motis" "http://localhost:8081/api/v1/geocode?text=test" "matches"
  check_http "otp" "http://localhost:8090/otp/routers" ""

  echo ""
  _bold "Geocoding:"
  check_http "nominatim" "http://localhost:8088/status" ""
  check_http "photon" "http://localhost:2322/api?q=test" "features"

  echo ""
  _bold "Data Services:"
  check_http "overpass" "http://localhost:8082/api/interpreter?data=[out:json];node(1);out;" "Overpass"
  check_http "tileserver" "http://localhost:8080/health" ""

  echo ""
  _bold "Application:"
  check_docker "api" "wget -qO- --timeout=5 http://localhost:3001/health 2>/dev/null || curl -sf http://localhost:3001/health" ""
  check_docker "web" "wget -qO- --timeout=5 http://localhost:3000 2>/dev/null || curl -sf http://localhost:3000" ""
  check_http "traefik" "http://localhost:80" ""

  echo ""
  echo "  ──────────────────"
  printf "  Passed: %d  Failed: %d  Skipped: %d\n" "$passed" "$failed" "$skipped"
  echo ""

  if [ "$failed" -gt 0 ]; then
    warn "Some services are not healthy. Check logs with: docker compose logs <service>"
  fi
}

# ── Update ───────────────────────────────────────────────────────────────

cmd_update() {
  log "Updating all data..."
  cmd_download_osm
  cmd_download_all_feeds
  cmd_download_style
  cmd_link
  cmd_build_all
  ok "Update complete"
}

# ── Clean ────────────────────────────────────────────────────────────────

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

# ── Help ─────────────────────────────────────────────────────────────────

cmd_help() {
  cat <<'HELP'
OpenMapX Data Manager

Manages OSM, GTFS, and map style data for all self-hosted services.
Downloads source data once and hardlinks it into each service's workspace
for zero-copy sharing.

COMMANDS:
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

  link                        Hard-link source data into service directories
                               Detects planet-scale and skips OSRM/OTP.

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

  status                      Show data inventory and disk usage

  check                       Test all running services for health
                               Checks HTTP endpoints, DB connections,
                               and reports pass/fail/skip for each.

  update                      Re-download all data and rebuild

  clean <target>              Remove data:
                               valhalla|osrm|otp|motis|tiles|pelias
                               nominatim|photon|overpass|styles
                               feeds    - all GTFS feeds
                               compiled - all compiled, keep sources
                               all      - everything

SELF-HOSTED SERVICES:
  Routing     Valhalla (planet-capable), OSRM (region-only)
  Transit     MOTIS (planet-capable), OTP (region-only)
  Geocoding   Pelias (ES-based), Nominatim (full OSM), Photon (lightweight)
  OSM Query   Overpass API (transit stops, POIs, trails)
  Map Tiles   Planetiler (vector MBTiles) + TileServer GL (styles)
  Elevation   Valhalla (SRTM data, auto-downloaded during build)
  Database    PostgreSQL + PostGIS, Redis, Elasticsearch

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
  # --- Full worldwide self-hosted setup ---
  ./manage.sh download-osm planet
  ./manage.sh download-all-feeds
  ./manage.sh download-style
  ./manage.sh link
  ./manage.sh build-all
  docker compose --profile proxy --profile app \
    --profile routing --profile transit \
    --profile nominatim --profile photon \
    --profile overpass --profile tiles up -d

  # --- Single country (lighter) ---
  ./manage.sh download-osm europe/germany
  ./manage.sh download-all-feeds de
  ./manage.sh download-style
  ./manage.sh link && ./manage.sh build-all

  # --- Just routing + tiles (minimal) ---
  ./manage.sh download-osm europe/germany
  ./manage.sh download-style
  ./manage.sh link
  ./manage.sh build valhalla && ./manage.sh build tiles
  docker compose --profile routing --profile tiles up -d

  # --- Weekly update (cron-friendly) ---
  0 3 * * 0 cd /path/to/infra/docker && ./manage.sh update

ENVIRONMENT:
  DATA_DIR                  Data directory (default: ./data)
  REGION                    Default OSM region (default from data.conf)
  MAX_CONCURRENT_DOWNLOADS  Parallel feed downloads (default: 5)
  NOMINATIM_THREADS         Nominatim import threads (default: 8)

HELP
}

# ── Main ─────────────────────────────────────────────────────────────────

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
    status)                  cmd_status ;;
    check)                   cmd_check ;;
    update)                  cmd_update ;;
    clean)                   shift; cmd_clean "$@" ;;
    help|--help|-h)          cmd_help ;;
    *)                       err "Unknown command: $1"; echo ""; cmd_help; exit 1 ;;
  esac
}

main "$@"
