import {
  createBoundedBinaryProxyStream,
  MAX_VECTOR_TILE_BYTES,
  VECTOR_TILE_MEDIA_TYPES,
} from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";

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
    async (req, reply) => {
      const { network, layout, z, x, y } = req.params as Record<string, string>;
      if (
        !NETWORKS.has(network) ||
        !LAYOUTS.has(layout) ||
        !/^[0-9]{1,2}$/.test(z) ||
        !/^[0-9]+$/.test(x) ||
        !/^[0-9]+$/.test(y)
      ) {
        reply.status(400).send({ message: "Invalid tile path" });
        return;
      }

      const url = `${tileBaseUrl}/${network}/${layout}/${z}/${x}/${y}.mvt`;
      try {
        // Raw fetch: fetchJson cannot express a binary stream. 25s matches the
        // production-tuned budget for vector-tile fan-out (see the Panoramax proxy).
        const timeoutSignal = AbortSignal.timeout(25_000);
        const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
        const upstream = await fetch(url, { signal });

        if (upstream.status === 404) {
          // LOOM answers 404 for every empty or unavailable tile (oceans, sparse
          // regions). That is data, not failure: an empty 204 renders as an empty
          // tile with no MapLibre error noise.
          reply.header("Cache-Control", "public, max-age=86400");
          reply.status(204).send(undefined);
          return;
        }
        if (!upstream.ok) {
          reply.status(upstream.status).send({ message: "LOOM tile unavailable" });
          return;
        }

        const proxy = createBoundedBinaryProxyStream(upstream, {
          maxBytes: MAX_VECTOR_TILE_BYTES,
          allowedContentTypes: VECTOR_TILE_MEDIA_TYPES,
          fallbackContentType: "application/vnd.mapbox-vector-tile",
          label: "LOOM vector tile",
        });
        reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.type(proxy.contentType);
        reply.send(proxy.body);
      } catch (error) {
        ctx.log.warn(
          `LOOM tile request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        reply.status(502).send({ message: "LOOM tile unavailable" });
      }
    },
    { rateLimitTier: "tile" },
  );
}
