import { USER_AGENT } from "@openmapx/core";
import {
  createBoundedBinaryProxyStream,
  MAX_RASTER_TILE_BYTES,
  RASTER_IMAGE_MEDIA_TYPES,
} from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";

export function setup(ctx: IntegrationContext): void {
  const tileUrl =
    (ctx.config.tileUrl as string | undefined) ??
    "https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png";

  ctx.registerRoute("GET", "/tiles/:z/:x/:y.png", async (req, reply) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (![z, x, y].every((v) => Number.isFinite(v) && v >= 0)) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }

    const baseUrl = tileUrl;
    const url = baseUrl
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));

    try {
      const timeoutSignal = AbortSignal.timeout(15_000);
      const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
      if (!response.ok) {
        reply.status(response.status).send({ message: "Upstream tile fetch failed" });
        return;
      }
      const proxy = createBoundedBinaryProxyStream(response, {
        maxBytes: MAX_RASTER_TILE_BYTES,
        allowedContentTypes: RASTER_IMAGE_MEDIA_TYPES,
        fallbackContentType: "image/png",
        label: "OpenSnowMap tile",
      });
      reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.type(proxy.contentType);
      reply.send(proxy.body);
    } catch (err) {
      ctx.log.warn("Winter sports tile fetch failed", err);
      reply.status(502).send({ message: "Winter sports tile provider unavailable" });
    }
  });
}
