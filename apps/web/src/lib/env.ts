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
  mapillaryToken: string;
  mapStyleUrl: string;
  tilesUrl: string;
  styleProvider: "maptiler" | "openmapx";
  trafficMinZoom: number;
  trafficTileUrlTemplate: string;
  cyclOsmTileUrlTemplate: string;
  terrainTileUrlTemplate: string;
}

/**
 * Build the client environment config from process.env.
 * Must only be called from server components (where process.env is real).
 */
export function buildClientEnv(): ClientEnv {
  const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

  const parsedZoom = Number(process.env.NEXT_PUBLIC_TRAFFIC_MIN_ZOOM || "10");
  const trafficMinZoom =
    Number.isFinite(parsedZoom) && parsedZoom >= 0 && parsedZoom <= 22 ? parsedZoom : 10;

  return {
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "",
    mapillaryToken: process.env.NEXT_PUBLIC_MAPILLARY_TOKEN ?? "",
    mapStyleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "",
    tilesUrl: process.env.NEXT_PUBLIC_TILES_URL ?? "",
    styleProvider:
      (process.env.NEXT_PUBLIC_STYLE_PROVIDER as "maptiler" | "openmapx") || "openmapx",
    trafficMinZoom,
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
    terrainTileUrlTemplate:
      process.env.NEXT_PUBLIC_TERRAIN_TILE_URL_TEMPLATE ||
      (apiBase
        ? `${apiBase}/api/tiles/terrain/{z}/{x}/{y}.png`
        : "/api/tiles/terrain/{z}/{x}/{y}.png"),
  };
}
