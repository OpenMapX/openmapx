import type { IntegrationContext } from "@openmapx/integration-framework";
import { createTileProxyHandler } from "@openmapx/integration-framework/tile-proxy";

const DEFAULT_TILE_BASE_URL = "https://loom.cs.uni-freiburg.de/tiles";

const NETWORKS = new Set(["tram", "subway-lightrail", "rail-commuter", "rail"]);
/** `geo-octi` is documented upstream but currently 404s for every tile, so it is not offered. */
const LAYOUTS = new Set(["geo", "octi", "orthorad"]);

export function setup(ctx: IntegrationContext): void {
  const tileBaseUrl = (
    (ctx.config.tileBaseUrl as string | undefined) || DEFAULT_TILE_BASE_URL
  ).replace(/\/$/, "");

  ctx.registerRoute(
    "GET",
    "/tiles/:network/:layout/:z/:x/:y",
    createTileProxyHandler(ctx, {
      kind: "vector",
      label: "LOOM vector tile",
      url: ({ z, x, y }, { params }) => {
        const { network = "", layout = "" } = params;
        if (!NETWORKS.has(network) || !LAYOUTS.has(layout)) return null;
        return `${tileBaseUrl}/${network}/${layout}/${z}/${x}/${y}.mvt`;
      },
      // Matches the production-tuned budget for vector-tile fan-out (see the Panoramax proxy).
      timeoutMs: 25_000,
      fallbackContentType: "application/vnd.mapbox-vector-tile",
      cacheControl: "public, max-age=604800, s-maxage=604800",
      // LOOM answers 404 for every empty or unavailable tile (oceans, sparse
      // regions). That is data, not failure: an empty 204 renders as an empty
      // tile with no MapLibre error noise.
      empty: { statuses: [404], cacheControl: "public, max-age=86400" },
    }),
    { rateLimitTier: "tile" },
  );
}
