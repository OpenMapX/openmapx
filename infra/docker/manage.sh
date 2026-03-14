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
TRANSITOUS_REPO="https://github.com/transitous/transitous.git"
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

ensure_dirs() {
  mkdir -p \
    "${DATA_DIR}/osm" \
    "${DATA_DIR}/gtfs" \
    "${DATA_DIR}/osrm" \
    "${DATA_DIR}/valhalla" \
    "${DATA_DIR}/otp" \
    "${DATA_DIR}/motis" \
    "${DATA_DIR}/tileserver" \
    "${DATA_DIR}/pelias/openstreetmap" \
    "${DATA_DIR}/pelias/whosonfirst" \
    "${DATA_DIR}/pelias/placeholder"
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

cmd_download_all_feeds() {
  require_cmd jq git

  local country_filter="${1:-}"
  ensure_dirs

  local catalog_dir="${DATA_DIR}/.transitous-catalog"

  # Clone or update the Transitous catalog
  if [ -d "$catalog_dir/.git" ]; then
    log "Updating Transitous catalog..."
    git -C "$catalog_dir" pull --ff-only -q 2>/dev/null || warn "Could not update Transitous catalog — using cached version"
  else
    log "Cloning Transitous feed catalog (one-time, ~50 MB)..."
    rm -rf "$catalog_dir"
    git clone --depth 1 -q "$TRANSITOUS_REPO" "$catalog_dir"
  fi

  # Parse all feed files and extract GTFS HTTP URLs
  local feed_list="${DATA_DIR}/.feed-urls.txt"
  : > "$feed_list"

  local feed_files
  feed_files=$(find "$catalog_dir/feeds" -name "*.json" -type f 2>/dev/null | sort)

  if [ -z "$feed_files" ]; then
    err "No feed files found in catalog"
    return 1
  fi

  local total_feeds=0
  for feed_file in $feed_files; do
    local filename
    filename=$(basename "$feed_file" .json)
    # Extract country code from filename (e.g., "de" from "de.json" or "de-by" from "de-by.json")
    local cc
    cc=$(echo "$filename" | sed 's/[.-].*//' | tr '[:upper:]' '[:lower:]')

    # Apply country filter if specified
    if [ -n "$country_filter" ] && [ "$cc" != "$country_filter" ]; then
      continue
    fi

    # Extract all HTTP GTFS sources from this feed file using jq
    local sources
    sources=$(jq -r '
      .sources[]
      | select(.type == "http")
      | select((.spec // "gtfs") == "gtfs")
      | select((.skip // false) == false)
      | select(.url != null)
      | "\(.name)\t\(.url)"
    ' "$feed_file" 2>/dev/null || true)

    while IFS=$'\t' read -r name url; do
      [ -z "$url" ] && continue
      # Generate slug from country code + name
      local slug
      slug=$(echo "${cc}_${name}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g' | sed 's/__*/_/g' | sed 's/^_\|_$//g')
      echo "${slug}|${url}" >> "$feed_list"
      total_feeds=$((total_feeds + 1))
    done <<< "$sources"
  done

  if [ "$total_feeds" -eq 0 ]; then
    if [ -n "$country_filter" ]; then
      err "No feeds found for country: $country_filter"
    else
      err "No feeds found in catalog"
    fi
    return 1
  fi

  # Count how many are already downloaded
  local existing=0
  while IFS='|' read -r slug url; do
    [ -f "${DATA_DIR}/gtfs/${slug}.gtfs.zip" ] && existing=$((existing + 1))
  done < "$feed_list"

  if [ -n "$country_filter" ]; then
    log "Found ${total_feeds} GTFS feeds for country '${country_filter}' (${existing} already downloaded)"
  else
    log "Found ${total_feeds} GTFS feeds worldwide (${existing} already downloaded)"
  fi

  # Download missing feeds with concurrency control
  local downloaded=0
  local failed=0
  local skipped=0
  local running=0

  while IFS='|' read -r slug url; do
    local dest="${DATA_DIR}/gtfs/${slug}.gtfs.zip"

    # Skip if already downloaded
    if [ -f "$dest" ] && [ "$(file_size "$dest")" -gt 100 ]; then
      skipped=$((skipped + 1))
      continue
    fi

    # Concurrency control: wait if too many background jobs
    while [ "$running" -ge "$MAX_CONCURRENT_DOWNLOADS" ]; do
      wait -n 2>/dev/null || true
      running=$((running - 1))
    done

    # Download in background
    (
      if curl -fsSL --max-time 600 -o "$dest" "$url" 2>/dev/null; then
        if [ -f "$dest" ] && [ "$(file_size "$dest")" -gt 100 ]; then
          ok "  ${slug} ($(human_size "$(file_size "$dest")"))"
        else
          rm -f "$dest"
        fi
      else
        rm -f "$dest"
      fi
    ) &
    running=$((running + 1))
    downloaded=$((downloaded + 1))

  done < "$feed_list"

  # Wait for remaining background downloads
  wait

  # Count successful downloads
  local success=0
  while IFS='|' read -r slug url; do
    [ -f "${DATA_DIR}/gtfs/${slug}.gtfs.zip" ] && success=$((success + 1))
  done < "$feed_list"
  failed=$((total_feeds - success))

  echo ""
  ok "GTFS download complete: ${success}/${total_feeds} feeds available (${skipped} cached, ${failed} failed)"

  # Show total GTFS size
  local gtfs_size
  gtfs_size=$(du -sh "${DATA_DIR}/gtfs" 2>/dev/null | cut -f1 || echo "0")
  log "Total GTFS data: ${gtfs_size}"
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
    ln -f "$pbf" "${DATA_DIR}/valhalla/${pbf_name}" && ok "  -> valhalla/${pbf_name}"
    linked=$((linked + 1))

    # MOTIS — optional OSM for street routing
    ln -f "$pbf" "${DATA_DIR}/motis/${pbf_name}" && ok "  -> motis/${pbf_name}"
    linked=$((linked + 1))

    # Pelias — for geocoding import
    ln -f "$pbf" "${DATA_DIR}/pelias/openstreetmap/data.osm.pbf" && ok "  -> pelias/openstreetmap/data.osm.pbf"
    linked=$((linked + 1))

    if [ "$planet" = true ]; then
      warn "Skipping OSRM link (planet PBF needs ~200 GB RAM for OSRM — use Valhalla instead)"
      warn "Skipping OTP link (planet PBF too large for OTP — use MOTIS instead)"
    else
      # OSRM — region-scale only
      ln -f "$pbf" "${DATA_DIR}/osrm/region.osm.pbf" && ok "  -> osrm/region.osm.pbf"
      linked=$((linked + 1))

      # OTP — region-scale only
      ln -f "$pbf" "${DATA_DIR}/otp/${pbf_name}" && ok "  -> otp/${pbf_name}"
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

    ln -f "$feed" "${DATA_DIR}/motis/${feed_name}"
    linked=$((linked + 1))

    if [ "$planet" = false ]; then
      ln -f "$feed" "${DATA_DIR}/otp/${feed_name}"
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
    err "Usage: manage.sh build <valhalla|osrm|otp|motis|tiles>"
    return 1
  fi

  case "$service" in
    valhalla) build_valhalla ;;
    osrm)     build_osrm ;;
    otp)      build_otp ;;
    motis)    build_motis ;;
    tiles)    build_tiles ;;
    pelias)   build_pelias ;;
    *)        err "Unknown service: $service"; return 1 ;;
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

  docker compose -f "$COMPOSE_FILE" \
    run --rm --no-deps valhalla \
    valhalla_build_tiles -c /custom_files/valhalla.json /custom_files/*.osm.pbf
  ok "Valhalla build complete"
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

  log "Building OSRM routing data..."
  docker compose -f "$COMPOSE_FILE" run --rm osrm-build
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
  docker compose -f "$COMPOSE_FILE" run --rm otp-build
  ok "OTP build complete"
}

build_motis() {
  if ! ls "${DATA_DIR}/motis/"*.zip 1>/dev/null 2>&1; then
    warn "No GTFS feeds linked for MOTIS"
  fi

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

  docker run --rm \
    -e JAVA_TOOL_OPTIONS="-Xmx30g" \
    -v "${DATA_DIR}/osm:/osm:ro" \
    -v "${DATA_DIR}/tileserver:/output" \
    ghcr.io/onthegomap/planetiler:latest \
    --osm-path="/osm/${pbf_name}" \
    --output="/output/tiles.mbtiles" \
    --nodemap-type=array \
    --force
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
  docker compose -f "$COMPOSE_FILE" --profile pelias up -d elasticsearch
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
  docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-schema
  ok "Schema created"

  # Download and import Who's on First
  log "Downloading and importing Who's on First administrative data..."
  docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-whosonfirst-import
  ok "Who's on First import complete"

  # Import OpenStreetMap
  log "Importing OpenStreetMap data..."
  docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-openstreetmap-import
  ok "OpenStreetMap import complete"

  # Build placeholder
  log "Building placeholder (coarse geocoding) data..."
  docker compose -f "$COMPOSE_FILE" --profile build run --rm pelias-placeholder-build
  ok "Placeholder build complete"

  ok "Pelias geocoding index built. Start with: docker compose --profile pelias up -d"
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
  for svc in valhalla osrm otp motis tileserver pelias; do
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
  for sub in osm gtfs osrm valhalla otp motis tileserver pelias; do
    local dir="${DATA_DIR}/${sub}"
    if [ -d "$dir" ]; then
      local size
      size=$(du -sh "$dir" 2>/dev/null | cut -f1 || echo "0")
      printf "  %-14s %s\n" "${sub}/" "$size"
    fi
  done
  echo "  ──────────────────"
  du -sh "${DATA_DIR}" 2>/dev/null | awk '{printf "  %-14s %s\n", "TOTAL", $1}'
  echo ""

  # Resource requirements
  if is_planet 2>/dev/null; then
    echo ""
    _bold "Planet-Scale Resource Requirements:"
    echo "  Valhalla build:   ~16 GB RAM, ~8 hours"
    echo "  Planetiler tiles: ~30 GB RAM, ~1 hour"
    echo "  MOTIS import:     ~8 GB RAM, ~30 min per 100 feeds"
    echo "  OSRM:             DISABLED (needs ~200 GB RAM)"
    echo "  OTP:              DISABLED (needs ~100 GB RAM)"
    echo ""
  fi
}

# ── Update ───────────────────────────────────────────────────────────────

cmd_update() {
  log "Updating all data..."
  cmd_download_osm
  cmd_download_all_feeds
  cmd_link
  cmd_build_all
  ok "Update complete"
}

# ── Clean ────────────────────────────────────────────────────────────────

cmd_clean() {
  local target="${1:-}"

  if [ -z "$target" ]; then
    err "Usage: manage.sh clean <valhalla|osrm|otp|motis|tiles|feeds|compiled|all>"
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

Manages OSM and GTFS data for self-hosted services. Downloads source data
once and hardlinks it into each service's workspace for zero-copy sharing.

COMMANDS:
  download-osm [region]       Download OSM PBF from Geofabrik
                               Use "planet" for worldwide (~70 GB).
                               Default region from data.conf.
                               Regions: https://download.geofabrik.de/

  add-feed <url> [slug]       Download a single GTFS feed

  download-all-feeds [cc]     Download ALL feeds from Transitous catalog
                               Optional: 2-letter country code filter.
                               Requires: jq, git

  remove-feed <slug>          Remove a GTFS feed and its links

  link                        Hard-link source data into service directories
                               Detects planet-scale and skips OSRM/OTP.

  build <service>             Build data for a service:
                               valhalla - Routing tiles (planet-capable)
                               osrm     - Routing graph (region-only)
                               otp      - Transit graph (region-only)
                               motis    - Auto-builds on container start
                               tiles    - Vector MBTiles via Planetiler
                               pelias   - Geocoding index (ES + WOF + OSM)

  build-all                   Build all applicable services

  status                      Show data inventory and disk usage

  update                      Re-download all data and rebuild

  clean <target>              Remove data:
                               valhalla|osrm|otp|motis|tiles|pelias
                               feeds    - all GTFS feeds
                               compiled - all compiled, keep sources
                               all      - everything

PLANET-SCALE NOTES:
  When using planet PBF (~70 GB), the manager automatically:
  - Skips OSRM (needs ~200 GB RAM) → use Valhalla instead
  - Skips OTP (needs ~100 GB RAM)  → use MOTIS instead
  - Builds Valhalla (~16 GB RAM, ~8 hours)
  - Builds Planetiler tiles (~30 GB RAM, ~1 hour, ~80 GB output)
  - Links GTFS feeds to MOTIS only (not OTP)

EXAMPLES:
  # --- Worldwide setup ---
  ./manage.sh download-osm planet
  ./manage.sh download-all-feeds
  ./manage.sh link
  ./manage.sh build-all
  docker compose --profile routing --profile transit --profile tiles up -d

  # --- Single country ---
  ./manage.sh download-osm europe/germany
  ./manage.sh download-all-feeds de
  ./manage.sh link && ./manage.sh build-all

  # --- Add feeds for a specific country ---
  ./manage.sh download-all-feeds ch

  # --- Weekly update (cron-friendly) ---
  0 3 * * 0 cd /path/to/infra/docker && ./manage.sh update

ENVIRONMENT:
  DATA_DIR                  Data directory (default: ./data)
  REGION                    Default OSM region (default from data.conf)
  MAX_CONCURRENT_DOWNLOADS  Parallel feed downloads (default: 5)

HELP
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
  case "${1:-help}" in
    download-osm)            shift; cmd_download_osm "$@" ;;
    add-feed|download-gtfs)  shift; cmd_download_gtfs "$@" ;;
    download-all-feeds)      shift; cmd_download_all_feeds "$@" ;;
    remove-feed)             shift; cmd_remove_feed "$@" ;;
    link)                    cmd_link ;;
    build)                   shift; cmd_build "$@" ;;
    build-all)               cmd_build_all ;;
    status)                  cmd_status ;;
    update)                  cmd_update ;;
    clean)                   shift; cmd_clean "$@" ;;
    help|--help|-h)          cmd_help ;;
    *)                       err "Unknown command: $1"; echo ""; cmd_help; exit 1 ;;
  esac
}

main "$@"
