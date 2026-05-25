import type { ClientEnv } from "./env";

const SELF_HOSTED_STYLES: Record<string, string> = {
  "bright-v2": "osm-bright",
  "streets-v2": "osm-bright",
  "streets-v2-dark": "dark-matter",
  satellite: "osm-bright",
  "topo-v2": "osm-bright",
};

function apiRoute(env: ClientEnv, path: string): string {
  const base = env.apiUrl.replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export function maptilerStyleUrl(style = "bright-v2", env: ClientEnv): string {
  if (env.mapStyleUrl) {
    const base = env.mapStyleUrl.replace(/\/$/, "");
    const mappedStyle = SELF_HOSTED_STYLES[style] ?? "osm-bright";
    return `${base}/styles/${mappedStyle}/style.json`;
  }
  return apiRoute(env, `/api/maptiler/maps/${encodeURIComponent(style)}/style.json`);
}

/**
 * Fetch the MapTiler style JSON and blank out any baked-in source
 * `attribution` strings. The upstream tilejson ships a bundled
 * "© MapTiler © OSM" anchor with `target="_blank"` (and no `rel`), which
 * MapLibre's substring dedup cannot collapse against the per-Attribution
 * anchors `BaseAttributions` registers (they include `rel="noopener
 * noreferrer"`). Stripping the bundled value lets `useMapAttributions` be
 * the single source of truth for credits, the same way `loadOpenMapXStyle`
 * already does for the self-hosted style.
 */
export async function loadMaptilerStyle(
  style: string,
  env: ClientEnv,
): Promise<Record<string, unknown>> {
  const url = maptilerStyleUrl(style, env);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load MapTiler style "${style}": HTTP ${res.status}`);
  }
  const styleJson = (await res.json()) as { sources?: Record<string, { attribution?: string }> };
  if (styleJson.sources) {
    for (const src of Object.values(styleJson.sources)) {
      if (src && typeof src === "object" && "attribution" in src) {
        src.attribution = "";
      }
    }
  }
  return styleJson as Record<string, unknown>;
}

export async function loadOpenMapXStyle(env: ClientEnv): Promise<Record<string, unknown>> {
  const res = await fetch("/styles/openmapx-streets.json");
  if (!res.ok) {
    throw new Error(`Failed to load OpenMapX style: HTTP ${res.status}`);
  }
  const style = await res.json();

  const tilesUrl = env.tilesUrl || apiRoute(env, "/api/maptiler/tiles/v3-openmaptiles/tiles.json");
  style.sources.openmaptiles.url = tilesUrl;
  // Attribution is contributed via `useMapAttributions` (per-Attribution
  // side-channel sources) so MapLibre's substring dedup works cleanly across
  // layers. The upstream MapTiler tilejson bakes a bundled "© MapTiler © OSM"
  // string into its `attribution` field — explicitly set this to empty so
  // MapLibre's source spec wins over the tilejson value and doesn't
  // re-introduce the bundled string. See useMapAttributions.ts.
  style.sources.openmaptiles.attribution = "";

  style.sprite = `${window.location.origin}/styles/sprite`;

  const glyphBase = env.mapStyleUrl
    ? `${env.mapStyleUrl.replace(/\/$/, "")}/fonts`
    : apiRoute(env, "/api/maptiler/fonts");
  style.glyphs = `${glyphBase}/{fontstack}/{range}.pbf`;

  return style;
}
