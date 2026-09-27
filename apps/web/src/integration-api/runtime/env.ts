/**
 * Runtime environment configuration for the web app.
 *
 * Server components read process.env directly at request time — no issues.
 * Client components CANNOT read process.env reliably in Docker builds because
 * Next.js inlines NEXT_PUBLIC_* at build time and the minifier dead-code-
 * eliminates fallback branches.
 *
 * Instead, the root layout (server component) calls buildClientEnv() once per
 * request and passes the result to an EnvProvider context.  Client components
 * read from the context via the useEnv() hook.
 */

export interface ClientEnv {
  apiUrl: string;
  mapStyleUrl: string;
  tilesUrl: string;
  styleProvider: "maptiler" | "openmapx";
  trafficTileUrlTemplate: string;
  cyclOsmTileUrlTemplate: string;
  terrainDemTilejsonUrl: string;
  terrainContourTilejsonUrl: string;
  terrainAttributionName: string;
  terrainAttributionUrl: string;
  /** Martin vector-tile server base (Traefik-proxied at `/martin`); first consumer is overlay-traffic-flow. */
  martinBaseUrl: string;
}

/**
 * Build the client environment config from process.env.
 * Must only be called from server components (where process.env is real).
 */
export function buildClientEnv(): ClientEnv {
  const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

  return {
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "",
    mapStyleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "",
    tilesUrl: process.env.NEXT_PUBLIC_TILES_URL ?? "",
    styleProvider:
      (process.env.NEXT_PUBLIC_STYLE_PROVIDER as "maptiler" | "openmapx") || "openmapx",
    trafficTileUrlTemplate:
      process.env.NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE ||
      (apiBase
        ? `${apiBase}/api/traffic/flow/{z}/{x}/{y}.png`
        : "/api/traffic/flow/{z}/{x}/{y}.png"),
    cyclOsmTileUrlTemplate:
      process.env.NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE ||
      (apiBase
        ? `${apiBase}/api/tiles/cyclosm/{z}/{x}/{y}.png`
        : "/api/tiles/cyclosm/{z}/{x}/{y}.png"),
    terrainDemTilejsonUrl:
      process.env.NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL ||
      `${apiBase}/api/maptiler/tiles/terrain-rgb-v2/tiles.json`,
    terrainContourTilejsonUrl:
      process.env.NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL ||
      `${apiBase}/api/maptiler/tiles/contours-v2/tiles.json`,
    terrainAttributionName: process.env.NEXT_PUBLIC_TERRAIN_ATTRIBUTION_NAME || "© MapTiler",
    terrainAttributionUrl:
      process.env.NEXT_PUBLIC_TERRAIN_ATTRIBUTION_URL || "https://www.maptiler.com/copyright/",
    martinBaseUrl:
      process.env.NEXT_PUBLIC_MARTIN_URL || (apiBase ? `${apiBase}/martin` : "/martin"),
  };
}
