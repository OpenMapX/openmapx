import type { OfflineMapPackageManifest } from "@openmapx/core";
import { escapeHtml, sanitizeUrl } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { ClientEnv } from "./env";
import { resolveOfflinePackageStyle } from "./offlineAreas/packageStyle";

/**
 * Canonical base-map credits — the single source of truth for the OSM /
 * OpenMapTiles / MapTiler attribution shown across the app. `BaseAttributions`
 * registers these in the main map's attribution registry (rendered by
 * `MapFooter`); `baseMapCreditsHtml` (below) renders the same objects as HTML
 * for the embedded maps, which render them through `<MapCredits>` instead of
 * registering them. Defined once here so a credit/URL/license change can't
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
 * Render a base-map credit as an HTML anchor, keeping the leading "© " outside
 * the link to match the form `useMapAttributions` registers — so the substring
 * dedup collapses identical credits regardless of which path emitted them.
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

function apiRoute(env: ClientEnv, path: string): string {
  const base = env.apiUrl.replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export function maptilerStyleUrl(style = "bright-v2", env: ClientEnv): string {
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
 * Base-map credits as HTML for `<MapCredits>` on an embedded map that does NOT
 * mount `BaseAttributions`/`useMapAttributions` — the offline area picker, the
 * offline preview, and the place / street-level mini-map. Both
 * `loadMaptilerStyle` and `loadOpenMapXStyle` blank the style's own source
 * `attribution`, so these strings are the single source of truth for credits on
 * those maps. Credits (see {@link baseMapVectorCredits}): OSM (data) +
 * OpenMapTiles (our OSM-Bright-derived style — CC-BY 4.0 design + the schema)
 * always, plus MapTiler when their hosted tiles are used. Rendered from the
 * shared {@link OSM_ATTRIBUTION} et al. so the metadata can't drift from the
 * main map's.
 */
export function baseMapCreditsHtml(env: ClientEnv): string[] {
  return baseMapVectorCredits(env).map(creditHtml);
}

/**
 * The vector base-map credits owed for our style, in display order:
 * - OpenStreetMap — the underlying data (ODbL).
 * - OpenMapTiles — our style derives from OSM Bright, whose design is CC-BY 4.0
 *   and requires a visible "© OpenMapTiles" credit; the tile schema is theirs too.
 * - MapTiler — only when the deployment renders MapTiler's hosted `v3-openmaptiles`
 *   tiles (the default); a self-hosted tileserver drops it.
 */
export function baseMapVectorCredits(env: ClientEnv): Attribution[] {
  const credits = [OSM_ATTRIBUTION, OPENMAPTILES_ATTRIBUTION];
  if (!usesSelfHostedTiles(env)) credits.push(MAPTILER_ATTRIBUTION);
  return credits;
}

/** Which OpenMapX style variant to load — keyed on the resolved colour scheme. */
export type MapStyleVariant = "light" | "dark";

/**
 * Whether the deployment serves its own (OpenMapTiles) vector tiles rather than
 * MapTiler's. Drives the vendor attribution: self-hosted ⇒ © OpenMapTiles,
 * otherwise ⇒ © MapTiler (who hosts the `v3-openmaptiles` tiles our style uses
 * by default). OSM is credited separately in all cases.
 */
export function usesSelfHostedTiles(env: ClientEnv): boolean {
  return Boolean(env.tilesUrl);
}

export async function loadOpenMapXStyle(
  env: ClientEnv,
  variant: MapStyleVariant = "light",
  offlinePackages?: readonly {
    packageId: string;
    manifest: OfflineMapPackageManifest;
  }[],
): Promise<Record<string, unknown>> {
  const file = variant === "dark" ? "openmapx-dark.json" : "openmapx-streets.json";
  const res = await fetch(`/styles/${file}`);
  if (!res.ok) {
    throw new Error(`Failed to load OpenMapX style "${variant}": HTTP ${res.status}`);
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

  return offlinePackages
    ? resolveOfflinePackageStyle(style, offlinePackages, { apiBaseUrl: env.apiUrl })
    : style;
}
