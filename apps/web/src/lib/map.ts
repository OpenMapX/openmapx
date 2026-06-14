import { escapeHtml, sanitizeUrl } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { ClientEnv } from "./env";

/**
 * Canonical base-map credits — the single source of truth for the OSM /
 * OpenMapTiles / MapTiler attribution shown across the app. `BaseAttributions`
 * registers these as side-channel sources on the main map's AttributionControl;
 * `baseMapCustomAttribution` (below) renders the same objects as
 * `customAttribution` HTML for the direct-style maps that don't mount
 * `BaseAttributions`. Defined once here so a credit/URL/license change can't
 * drift between the two rendering paths.
 *
 * Publisher names are proper nouns rendered verbatim across locales (the
 * providers treat them as untranslated identifiers); the leading "©" is
 * universal. Do not pipe these through next-intl.
 */
export const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/",
};

export const OPENMAPTILES_ATTRIBUTION: Attribution = {
  sourceId: "openmaptiles",
  name: "© OpenMapTiles",
  url: "https://openmaptiles.org/",
  spdxLicense: "BSD-3-Clause",
  licenseUrl: "https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md",
};

export const MAPTILER_ATTRIBUTION: Attribution = {
  sourceId: "maptiler",
  name: "© MapTiler",
  url: "https://www.maptiler.com/copyright/",
};

/**
 * Render a base-map credit as an HTML anchor for MapLibre's `customAttribution`,
 * keeping the leading "© " outside the link to match the form
 * `useMapAttributions` registers — so MapLibre's substring dedup collapses
 * identical credits regardless of which path emitted them.
 */
function creditHtml(attr: Attribution): string {
  const hasCopyright = attr.name.startsWith("© ");
  const label = escapeHtml(hasCopyright ? attr.name.slice(2) : attr.name);
  const safeUrl = attr.url ? sanitizeUrl(attr.url) : undefined;
  const anchor = safeUrl
    ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
  return hasCopyright ? `© ${anchor}` : anchor;
}

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

/**
 * Base-map credits as `customAttribution` HTML for a directly-loaded style on a
 * map that does NOT mount `BaseAttributions`/`useMapAttributions` — the offline
 * area picker, the offline preview, and the place mini-map. Both
 * `loadMaptilerStyle` and `loadOpenMapXStyle` blank the style's own source
 * `attribution`, so these strings are the single source of truth for credits on
 * those maps. OSM is always credited; the vendor depends on the active style
 * provider. Rendered from the shared {@link OSM_ATTRIBUTION} et al. so the
 * credit metadata can't drift from the main map's.
 */
export function baseMapCustomAttribution(env: ClientEnv): string[] {
  const vendor = env.styleProvider === "openmapx" ? OPENMAPTILES_ATTRIBUTION : MAPTILER_ATTRIBUTION;
  return [creditHtml(OSM_ATTRIBUTION), creditHtml(vendor)];
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
