import {
  createBoundedBinaryProxyStream,
  MAX_VECTOR_TILE_BYTES,
  VECTOR_TILE_MEDIA_TYPES,
} from "@openmapx/core/server";
import { type IntegrationContext, scalarQueries } from "@openmapx/integration-framework";
import { createMapillaryProvider } from "./provider.js";

const TILE_PATH = "/api/integrations/street-level-imagery-mapillary/tiles/{z}/{x}/{y}";

/**
 * Upstream failures (timeout, rate-limit, 5xx) are reported as 502, never as a
 * 404. Answering "no imagery here" for a transient blip is a lie the caller
 * cannot distinguish from genuine absence, and it is the kind of lie that gets
 * cached and reasoned about downstream.
 */
async function upstream<T>(
  ctx: IntegrationContext,
  reply: { status: (code: number) => { send: (data: unknown) => void } },
  what: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    ctx.log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    reply.status(502).send({ message: `${what} is unavailable` });
    return { ok: false };
  }
}

export function setup(ctx: IntegrationContext): void {
  const token = (ctx.config.accessToken as string | undefined) ?? "";
  const provider = createMapillaryProvider({ accessToken: token, tileUrlTemplate: TILE_PATH });

  ctx.registerStreetLevelProvider(provider);

  ctx.registerRoute("GET", "/capabilities", async (_req, reply) => {
    reply.send(provider.capabilities());
  });

  ctx.registerRoute(
    "GET",
    "/tiles/:z/:x/:y",
    async (req, reply) => {
      if (!token) {
        reply.status(503).send({ message: "Mapillary token not configured" });
        return;
      }

      const { z, x, y } = req.params as { z: string; x: string; y: string };
      if (!/^[0-9]{1,2}$/.test(z) || !/^[0-9]+$/.test(x) || !/^[0-9]+$/.test(y)) {
        reply.status(400).send({ message: "Invalid tile coordinates" });
        return;
      }

      const url = `https://tiles.mapillary.com/maps/vtp/mly1_public/2/${z}/${x}/${y}?access_token=${token}`;
      // Raw fetch is required because fetchJson cannot express a binary stream.
      // 10s proved too tight in production: a viewport change fans out
      // 30-60 tile requests and these tiles run to hundreds of KB, so the
      // public instances regularly overran it and coverage went missing.
      try {
        const timeoutSignal = AbortSignal.timeout(25_000);
        const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
        const upstream = await fetch(url, { signal });
        if (!upstream.ok) {
          ctx.log.warn(`Mapillary tile request failed: ${upstream.status}`);
          reply.status(upstream.status).send({ message: "Mapillary tile unavailable" });
          return;
        }

        const proxy = createBoundedBinaryProxyStream(upstream, {
          maxBytes: MAX_VECTOR_TILE_BYTES,
          allowedContentTypes: VECTOR_TILE_MEDIA_TYPES,
          fallbackContentType: "application/vnd.mapbox-vector-tile",
          label: "Mapillary vector tile",
        });
        reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.type(proxy.contentType);
        reply.send(proxy.body);
      } catch (error) {
        ctx.log.warn("Mapillary tile request failed", error);
        reply.status(502).send({ message: "Mapillary tile unavailable" });
      }
    },
    { rateLimitTier: "tile" },
  );

  ctx.registerRoute("GET", "/nearest", async (req, reply) => {
    if (!token) {
      reply.status(503).send({ message: "Mapillary token not configured" });
      return;
    }

    const lat = Number((scalarQueries(req.query) as { lat?: string }).lat);
    const lng = Number((scalarQueries(req.query) as { lng?: string }).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    const found = await upstream(ctx, reply, "Mapillary imagery search", () =>
      provider.findNearest([lng, lat]),
    );
    if (!found.ok) return;
    const image = found.value;
    if (!image) {
      reply.status(404).send({ message: "No imagery found near this location" });
      return;
    }
    reply.send(image);
  });

  ctx.registerRoute("GET", "/images/:id", async (req, reply) => {
    if (!token) {
      reply.status(503).send({ message: "Mapillary token not configured" });
      return;
    }

    const { id } = req.params as { id: string };
    const found = await upstream(ctx, reply, "Mapillary imagery", () => provider.getImage(id));
    if (!found.ok) return;
    const image = found.value;
    if (!image) {
      reply.status(404).send({ message: "Image not found" });
      return;
    }
    reply.send(image);
  });

  ctx.registerRoute("GET", "/images/:id/links", async (req, reply) => {
    if (!token) {
      reply.status(503).send({ message: "Mapillary token not configured" });
      return;
    }

    const { id } = req.params as { id: string };
    const found = await upstream(ctx, reply, "Mapillary imagery links", () =>
      provider.getLinks(id),
    );
    if (!found.ok) return;
    reply.send(found.value);
  });
}
