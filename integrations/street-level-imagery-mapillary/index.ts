import type { IntegrationContext } from "@openmapx/integration-framework";
import { createMapillaryProvider } from "./provider.js";

const TILE_PATH = "/api/integrations/street-level-imagery-mapillary/tiles/{z}/{x}/{y}";

export function setup(ctx: IntegrationContext): void {
  const token = (ctx.config.accessToken as string | undefined) ?? "";
  const provider = createMapillaryProvider({ accessToken: token, tileUrlTemplate: TILE_PATH });

  ctx.registerStreetLevelProvider(provider);

  ctx.registerRoute("GET", "/capabilities", async (_req, reply) => {
    reply.send(provider.capabilities());
  });

  ctx.registerRoute("GET", "/tiles/:z/:x/:y", async (req, reply) => {
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
    // Raw fetch: forwards the upstream's binary tile body, content-type, and
    // status verbatim — fetchJson always parses JSON, so it can't express this.
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) {
      ctx.log.warn(`Mapillary tile request failed: ${upstream.status}`);
      reply.status(upstream.status).send({ message: "Mapillary tile unavailable" });
      return;
    }

    const bytes = await upstream.arrayBuffer();
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.type(upstream.headers.get("content-type") ?? "application/vnd.mapbox-vector-tile");
    reply.send(Buffer.from(bytes));
  });

  ctx.registerRoute("GET", "/nearest", async (req, reply) => {
    if (!token) {
      reply.status(503).send({ message: "Mapillary token not configured" });
      return;
    }

    const lat = Number((req.query as { lat?: string }).lat);
    const lng = Number((req.query as { lng?: string }).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    const image = await provider.findNearest([lng, lat]);
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
    const image = await provider.getImage(id);
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
    reply.send(await provider.getLinks(id));
  });
}
