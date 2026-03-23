/** MapTiler API key from environment. */
export const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

/**
 * Optional self-hosted map style base URL (overrides MapTiler).
 * Should point to TileServer GL, e.g. "https://example.com/tiles"
 * The function appends /styles/{style}/style.json automatically.
 */
const SELF_HOSTED_STYLE_BASE = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "";

/**
 * Optional self-hosted tile source URL for OpenMapTiles vector tiles.
 * Used by the custom OpenMapX style. Should point to tiles.json,
 * e.g. "https://tiles.example.com/v3/tiles.json"
 */
const SELF_HOSTED_TILES_URL = process.env.NEXT_PUBLIC_TILES_URL ?? "";

/**
 * Style provider: "maptiler" uses MapTiler Cloud, "openmapx" uses the custom style.
 * Default: "maptiler" (change to "openmapx" when self-hosted tiles are ready).
 */
export const STYLE_PROVIDER =
  (process.env.NEXT_PUBLIC_STYLE_PROVIDER as "maptiler" | "openmapx") ?? "maptiler";

/** Map from MapTiler style names to self-hosted TileServer GL style names. */
const SELF_HOSTED_STYLES: Record<string, string> = {
  "bright-v2": "osm-bright",
  "streets-v2": "osm-bright",
  "streets-v2-dark": "dark-matter",
  satellite: "osm-bright",
  "topo-v2": "osm-bright",
};

/**
 * Map style URL for MapTiler-based styles.
 *
 * If NEXT_PUBLIC_MAP_STYLE_URL is set, uses self-hosted TileServer GL styles.
 * Otherwise falls back to MapTiler Cloud.
 */
export function maptilerStyleUrl(style = "bright-v2"): string {
  if (SELF_HOSTED_STYLE_BASE) {
    const base = SELF_HOSTED_STYLE_BASE.replace(/\/$/, "");
    const mappedStyle = SELF_HOSTED_STYLES[style] ?? "osm-bright";
    return `${base}/styles/${mappedStyle}/style.json`;
  }
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}`;
}

/**
 * Fetch and patch the custom OpenMapX Streets style.
 * Replaces placeholder URLs for tiles, sprites, and fonts with actual values.
 */
export async function loadOpenMapXStyle(): Promise<Record<string, unknown>> {
  const res = await fetch("/styles/openmapx-streets.json");
  const style = await res.json();

  // Patch tile source URL
  const tilesUrl =
    SELF_HOSTED_TILES_URL ||
    `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${MAPTILER_KEY}`;
  style.sources.openmaptiles.url = tilesUrl;

  // Patch sprite URL (use local sprites bundled with the app)
  style.sprite = `${window.location.origin}/styles/sprite`;

  // Patch glyph URL — use MapTiler fonts as fallback, self-hosted if available
  const glyphBase = SELF_HOSTED_STYLE_BASE
    ? `${SELF_HOSTED_STYLE_BASE.replace(/\/$/, "")}/fonts`
    : `https://api.maptiler.com/fonts`;
  const glyphSuffix = SELF_HOSTED_STYLE_BASE ? "" : `?key=${MAPTILER_KEY}`;
  style.glyphs = `${glyphBase}/{fontstack}/{range}.pbf${glyphSuffix}`;

  return style;
}
