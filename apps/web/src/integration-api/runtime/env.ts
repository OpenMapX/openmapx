/**
 * Runtime environment configuration for the web app.
 *
 * Server components read process.env directly at request time — no issues.
 * Client components CANNOT read process.env reliably in Docker builds because
 * Next.js inlines NEXT_PUBLIC_* at build time and the minifier dead-code-
 * eliminates fallback branches.
 *
 * Instead, the root layout (server component) calls loadClientEnv() once per
 * request and passes the result to an EnvProvider context.  Client components
 * read from the context via the useEnv() hook.
 */

import { parseOperatorUrl } from "@openmapx/core/configuration-values";
import { hostedBasemapProviderSchema, type MapConfig } from "@openmapx/core/map-config";

export interface ClientEnv {
  basemapProvider?: "selfhosted" | "openfreemap" | "maptiler";
  apiUrl: string;
  mapStyleUrl: string;
  tilesUrl: string;
  styleProvider: "maptiler" | "openmapx";
  trafficTileUrlTemplate: string;
  trafficMinZoom?: number;
  cyclOsmTileUrlTemplate: string;
  terrainDemTilejsonUrl: string;
  terrainDemTileUrlTemplate: string;
  terrainDemEncoding: "mapbox" | "terrarium";
  terrainContourMode: "vector" | "generated";
  terrainContourTilejsonUrl: string;
  terrainAttributionName: string;
  terrainAttributionUrl: string;
  /** Martin vector-tile server base (Traefik-proxied at `/martin`); first consumer is overlay-traffic-flow. */
  martinBaseUrl: string;
}

/**
 * Build the client environment config from runtime.
 * Must only be called from server components (where process.env is real).
 */
export function buildClientEnv(
  mapConfig?: MapConfig,
  runtime: Readonly<Record<string, string | undefined>> = process.env,
): ClientEnv {
  // Reading through the object prevents Next's NEXT_PUBLIC build-time substitution.
  const url = (key: string, template = false) =>
    parseOperatorUrl(runtime[key] ?? "", template) || "";
  const rawZoom = runtime.NEXT_PUBLIC_TRAFFIC_MIN_ZOOM;
  const trafficMinZoom =
    rawZoom && /^\d+$/.test(rawZoom) && Number(rawZoom) <= 24 ? Number(rawZoom) : undefined;
  const apiBase = (runtime.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
  const tilesUrl = url("NEXT_PUBLIC_TILES_URL") || (mapConfig?.selfHostedTilesUrl ?? "");
  const mapStyleUrl = url("NEXT_PUBLIC_MAP_STYLE_URL") || (mapConfig?.selfHostedGlyphsUrl ?? "");
  const preference =
    mapConfig?.hostedBasemapProvider ??
    hostedBasemapProviderSchema.catch("auto").parse(runtime.BASEMAP_PROVIDER);
  const keyConfigured =
    mapConfig?.maptilerConfigured ??
    Boolean(runtime.MAPTILER_KEY?.trim() || runtime.NEXT_PUBLIC_MAPTILER_KEY?.trim());
  const basemapProvider = tilesUrl
    ? "selfhosted"
    : preference === "auto"
      ? keyConfigured
        ? "maptiler"
        : "openfreemap"
      : preference;
  const styleProvider =
    basemapProvider === "maptiler" && runtime.NEXT_PUBLIC_STYLE_PROVIDER === "maptiler"
      ? "maptiler"
      : "openmapx";
  const keylessTerrain = basemapProvider !== "maptiler";
  const customDem = Boolean(url("NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL"));
  const useMapterhorn = keylessTerrain && !customDem;
  const customContour = Boolean(url("NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL"));
  const generatedContours = (useMapterhorn || customDem) && !customContour;

  return {
    ...(trafficMinZoom === undefined ? {} : { trafficMinZoom }),
    apiUrl: runtime.NEXT_PUBLIC_API_URL ?? "",
    mapStyleUrl,
    tilesUrl,
    basemapProvider,
    styleProvider,
    trafficTileUrlTemplate:
      url("NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE", true) ||
      (apiBase
        ? `${apiBase}/api/traffic/flow/{z}/{x}/{y}.png`
        : "/api/traffic/flow/{z}/{x}/{y}.png"),
    cyclOsmTileUrlTemplate:
      url("NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE", true) ||
      (apiBase
        ? `${apiBase}/api/tiles/cyclosm/{z}/{x}/{y}.png`
        : "/api/tiles/cyclosm/{z}/{x}/{y}.png"),
    terrainDemTilejsonUrl:
      url("NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL") ||
      (useMapterhorn
        ? `${apiBase}/api/mapterhorn/tiles.json`
        : `${apiBase}/api/maptiler/tiles/terrain-rgb-v2/tiles.json`),
    terrainDemTileUrlTemplate:
      url("NEXT_PUBLIC_TERRAIN_DEM_TILE_URL_TEMPLATE", true) ||
      (useMapterhorn ? `${apiBase}/api/mapterhorn/{z}/{x}/{y}.webp` : ""),
    terrainDemEncoding:
      runtime.NEXT_PUBLIC_TERRAIN_DEM_ENCODING === "terrarium" || useMapterhorn
        ? "terrarium"
        : "mapbox",
    terrainContourMode: generatedContours ? "generated" : "vector",
    terrainContourTilejsonUrl:
      url("NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL") ||
      `${apiBase}/api/maptiler/tiles/contours-v2/tiles.json`,
    terrainAttributionName:
      runtime.NEXT_PUBLIC_TERRAIN_ATTRIBUTION_NAME ||
      (useMapterhorn ? "© Mapterhorn" : "© MapTiler"),
    terrainAttributionUrl:
      url("NEXT_PUBLIC_TERRAIN_ATTRIBUTION_URL") ||
      (useMapterhorn
        ? "https://mapterhorn.com/attribution/"
        : "https://www.maptiler.com/copyright/"),
    martinBaseUrl: url("NEXT_PUBLIC_MARTIN_URL") || (apiBase ? `${apiBase}/martin` : "/martin"),
  };
}
