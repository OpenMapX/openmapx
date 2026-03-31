#!/usr/bin/env bash
#
# OpenMapX Integration CLI
# Manage community integrations in custom_integrations/
#
# Usage:
#   ./scripts/integration.sh install <github:user/repo> [--ref <branch|tag>]
#   ./scripts/integration.sh install <path-to-directory>
#   ./scripts/integration.sh remove <integration-id>
#   ./scripts/integration.sh list
#   ./scripts/integration.sh validate <integration-id>
#   ./scripts/integration.sh build <integration-id>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CUSTOM_DIR="$ROOT_DIR/custom_integrations"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[integration]${NC} $*"; }
warn()  { echo -e "${YELLOW}[integration]${NC} $*"; }
error() { echo -e "${RED}[integration]${NC} $*" >&2; }
info()  { echo -e "${BLUE}[integration]${NC} $*"; }

usage() {
  cat <<EOF
OpenMapX Integration CLI

Usage:
  $(basename "$0") install <source>       Install a community integration
  $(basename "$0") remove <id>            Remove a community integration
  $(basename "$0") list                   List installed community integrations
  $(basename "$0") validate [<id>]        Validate manifest(s)
  $(basename "$0") build <id>             Build frontend bundle for a community integration

Sources:
  github:<user>/<repo>     Clone from GitHub (optionally --ref <branch|tag>)
  <local-path>             Copy from a local directory

Examples:
  $(basename "$0") install github:user/openmapx-weather-radar
  $(basename "$0") install github:user/openmapx-adsb --ref v1.0.0
  $(basename "$0") install ../my-local-integration
  $(basename "$0") remove weather-radar
  $(basename "$0") list
  $(basename "$0") validate weather-radar
  $(basename "$0") build weather-radar
EOF
  exit 1
}

ensure_custom_dir() {
  mkdir -p "$CUSTOM_DIR"
}

# --- install ---

cmd_install() {
  local source="${1:-}"
  [[ -z "$source" ]] && { error "Missing source argument"; usage; }

  local ref=""
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref) ref="${2:-}"; shift 2 ;;
      *) error "Unknown option: $1"; usage ;;
    esac
  done

  ensure_custom_dir

  if [[ "$source" == github:* ]]; then
    install_from_github "${source#github:}" "$ref"
  elif [[ -d "$source" ]]; then
    install_from_local "$source"
  else
    error "Unknown source format: $source"
    error "Use github:<user>/<repo> or a local directory path"
    exit 1
  fi
}

install_from_github() {
  local repo="$1"
  local ref="$2"
  local url="https://github.com/$repo.git"
  local tmp_dir
  tmp_dir=$(mktemp -d)

  log "Cloning $url ..."
  if [[ -n "$ref" ]]; then
    git clone --depth 1 --branch "$ref" "$url" "$tmp_dir" 2>&1 | sed 's/^/  /'
  else
    git clone --depth 1 "$url" "$tmp_dir" 2>&1 | sed 's/^/  /'
  fi

  if [[ ! -f "$tmp_dir/manifest.json" ]]; then
    error "No manifest.json found in repository root"
    rm -rf "$tmp_dir"
    exit 1
  fi

  local id
  id=$(python3 -c "import json; print(json.load(open('$tmp_dir/manifest.json'))['id'])" 2>/dev/null || true)
  if [[ -z "$id" ]]; then
    id=$(node -e "console.log(require('$tmp_dir/manifest.json').id)" 2>/dev/null || true)
  fi

  if [[ -z "$id" ]]; then
    error "Could not read 'id' from manifest.json"
    rm -rf "$tmp_dir"
    exit 1
  fi

  local target_dir="$CUSTOM_DIR/$id"
  if [[ -d "$target_dir" ]]; then
    warn "Integration '$id' already exists. Replacing..."
    rm -rf "$target_dir"
  fi

  # Remove .git directory (we don't need git history)
  rm -rf "$tmp_dir/.git"
  mv "$tmp_dir" "$target_dir"

  log "Installed integration: $id"

  # Install dependencies if package.json exists
  if [[ -f "$target_dir/package.json" ]]; then
    info "Installing dependencies..."
    (cd "$ROOT_DIR" && pnpm install 2>&1 | tail -3)
  fi

  validate_manifest "$id"
  log "Done. Restart the API server to activate."
}

install_from_local() {
  local source_dir="$1"

  if [[ ! -f "$source_dir/manifest.json" ]]; then
    error "No manifest.json found in $source_dir"
    exit 1
  fi

  local id
  id=$(node -e "console.log(require('$source_dir/manifest.json').id)" 2>/dev/null || true)

  if [[ -z "$id" ]]; then
    error "Could not read 'id' from manifest.json"
    exit 1
  fi

  local target_dir="$CUSTOM_DIR/$id"
  if [[ -d "$target_dir" ]]; then
    warn "Integration '$id' already exists. Replacing..."
    rm -rf "$target_dir"
  fi

  cp -r "$source_dir" "$target_dir"
  # Remove .git if copied from a repo
  rm -rf "$target_dir/.git"

  log "Installed integration: $id"

  if [[ -f "$target_dir/package.json" ]]; then
    info "Installing dependencies..."
    (cd "$ROOT_DIR" && pnpm install 2>&1 | tail -3)
  fi

  validate_manifest "$id"
  log "Done. Restart the API server to activate."
}

# --- remove ---

cmd_remove() {
  local id="${1:-}"
  [[ -z "$id" ]] && { error "Missing integration ID"; usage; }

  local target_dir="$CUSTOM_DIR/$id"
  if [[ ! -d "$target_dir" ]]; then
    error "Integration '$id' not found in $CUSTOM_DIR"
    exit 1
  fi

  rm -rf "$target_dir"
  log "Removed integration: $id"
  log "Restart the API server to deactivate."
}

# --- list ---

cmd_list() {
  ensure_custom_dir

  local found=0
  for dir in "$CUSTOM_DIR"/*/; do
    [[ ! -d "$dir" ]] && continue
    local manifest="$dir/manifest.json"
    [[ ! -f "$manifest" ]] && continue

    found=1
    local id name version quality
    id=$(node -e "const m=require('$manifest'); console.log(m.id)" 2>/dev/null || echo "?")
    name=$(node -e "const m=require('$manifest'); console.log(m.name)" 2>/dev/null || echo "?")
    version=$(node -e "const m=require('$manifest'); console.log(m.version||'?')" 2>/dev/null || echo "?")
    quality=$(node -e "const m=require('$manifest'); console.log(m.quality||'community')" 2>/dev/null || echo "community")

    local has_bundle=""
    [[ -f "$dir/dist/index.js" ]] && has_bundle=" [built]"

    echo -e "  ${GREEN}$id${NC} v$version ($quality) - $name$has_bundle"
  done

  if [[ $found -eq 0 ]]; then
    info "No community integrations installed."
    info "Install one with: $(basename "$0") install github:<user>/<repo>"
  fi
}

# --- validate ---

validate_manifest() {
  local id="$1"
  local manifest="$CUSTOM_DIR/$id/manifest.json"

  if [[ ! -f "$manifest" ]]; then
    error "manifest.json not found for '$id'"
    return 1
  fi

  # Basic JSON validation + required field checks
  node -e "
    const m = require('$manifest');
    const errors = [];
    if (!m.id) errors.push('id is required');
    if (!m.name) errors.push('name is required');
    if (!m.version) errors.push('version is required');
    if (!m.domains || !Array.isArray(m.domains)) errors.push('domains array is required');
    if (m.backend?.routes && (!m.attribution || m.attribution.length === 0))
      errors.push('attribution is required for integrations with backend routes');
    if (m.backend?.routes && !m.privacy)
      errors.push('privacy is required for integrations that call external APIs');
    if (m.attribution) {
      for (const a of m.attribution) {
        if (!a.name) errors.push('attribution.name is required');
        if (!a.url) errors.push('attribution.url is required');
        if (!a.license) errors.push('attribution.license is required');
      }
    }
    if (errors.length > 0) {
      console.error('Validation errors for ' + m.id + ':');
      errors.forEach(e => console.error('  - ' + e));
      process.exit(1);
    }
    console.log('Manifest valid: ' + m.id + ' (' + m.name + ')');
  " 2>&1 || return 1
}

cmd_validate() {
  local id="${1:-}"

  if [[ -n "$id" ]]; then
    validate_manifest "$id"
    return
  fi

  # Validate all
  ensure_custom_dir
  local all_valid=true
  for dir in "$CUSTOM_DIR"/*/; do
    [[ ! -d "$dir" ]] && continue
    [[ ! -f "$dir/manifest.json" ]] && continue
    local mid
    mid=$(basename "$dir")
    validate_manifest "$mid" || all_valid=false
  done

  if $all_valid; then
    log "All manifests valid."
  else
    error "Some manifests have errors."
    exit 1
  fi
}

# --- build ---

cmd_build() {
  local id="${1:-}"
  [[ -z "$id" ]] && { error "Missing integration ID"; usage; }

  local target_dir="$CUSTOM_DIR/$id"
  if [[ ! -d "$target_dir" ]]; then
    error "Integration '$id' not found"
    exit 1
  fi

  if [[ ! -f "$target_dir/manifest.json" ]]; then
    error "No manifest.json in $target_dir"
    exit 1
  fi

  # Check if integration has frontend components
  local has_frontend=false
  [[ -f "$target_dir/map-layer.tsx" ]] && has_frontend=true
  [[ -f "$target_dir/legend.tsx" ]] && has_frontend=true
  [[ -f "$target_dir/panel.tsx" ]] && has_frontend=true

  if ! $has_frontend; then
    info "No frontend components found for '$id'. Skipping build."
    return
  fi

  log "Building frontend bundle for '$id'..."
  mkdir -p "$target_dir/dist"

  # Use esbuild to bundle frontend components
  local entry_file="$target_dir/.build-entry.tsx"

  # Generate entry point that registers all components
  {
    echo "// Auto-generated build entry"
    echo "import type { CommunityIntegrationModule } from '@openmapx/core';"
    echo ""
    echo "const mod: CommunityIntegrationModule = { id: '$id' };"
    [[ -f "$target_dir/map-layer.tsx" ]] && {
      echo "import { default as MapLayer } from './map-layer';"
      echo "mod.mapLayer = MapLayer;"
    }
    [[ -f "$target_dir/legend.tsx" ]] && {
      echo "import { default as Legend } from './legend';"
      echo "mod.legend = Legend;"
    }
    [[ -f "$target_dir/panel.tsx" ]] && {
      echo "import { default as Panel } from './panel';"
      echo "mod.panel = Panel;"
    }
    echo ""
    echo "window.__openmapx_integrations = window.__openmapx_integrations || [];"
    echo "window.__openmapx_integrations.push(mod);"
  } > "$entry_file"

  # Bundle with esbuild (externalize platform deps)
  npx esbuild "$entry_file" \
    --bundle \
    --format=esm \
    --outfile="$target_dir/dist/index.js" \
    --external:react \
    --external:react-dom \
    --external:@openmapx/core \
    --external:maplibre-gl \
    --external:@mui/* \
    --jsx=automatic \
    --target=es2022 \
    --minify 2>&1 | sed 's/^/  /'

  # Clean up
  rm -f "$entry_file"

  log "Bundle created: $target_dir/dist/index.js"
}

# --- main ---

case "${1:-}" in
  install)  shift; cmd_install "$@" ;;
  remove)   shift; cmd_remove "$@" ;;
  list)     cmd_list ;;
  validate) shift; cmd_validate "$@" ;;
  build)    shift; cmd_build "$@" ;;
  *)        usage ;;
esac
