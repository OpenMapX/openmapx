#!/bin/sh
set -e

# Replace build-time placeholders with runtime environment variables.
# Next.js inlines NEXT_PUBLIC_* as string literals during build — this script
# patches the compiled JS bundles so the image works with any configuration.

replace_env() {
  local placeholder="$1"
  local value="$2"
  # Always replace — use empty string for unset vars so JS fallback logic works
  find /app/apps/web/.next -name '*.js' -exec sed -i "s|${placeholder}|${value}|g" {} + 2>/dev/null || true
  find /app/apps/web/.next -name '*.html' -exec sed -i "s|${placeholder}|${value}|g" {} + 2>/dev/null || true
}

replace_env "__NEXT_PUBLIC_API_URL__" "$NEXT_PUBLIC_API_URL"
replace_env "__NEXT_PUBLIC_MAPTILER_KEY__" "$NEXT_PUBLIC_MAPTILER_KEY"
replace_env "__NEXT_PUBLIC_MAPILLARY_TOKEN__" "$NEXT_PUBLIC_MAPILLARY_TOKEN"
replace_env "__NEXT_PUBLIC_MAP_STYLE_URL__" "$NEXT_PUBLIC_MAP_STYLE_URL"
replace_env "__NEXT_PUBLIC_TILES_URL__" "$NEXT_PUBLIC_TILES_URL"
replace_env "__NEXT_PUBLIC_STYLE_PROVIDER__" "$NEXT_PUBLIC_STYLE_PROVIDER"
replace_env "__NEXT_PUBLIC_TRAFFIC_MIN_ZOOM__" "$NEXT_PUBLIC_TRAFFIC_MIN_ZOOM"
replace_env "__NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE__" "$NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE"
replace_env "__NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE__" "$NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE"

exec "$@"
