import { fetchJson } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";

interface MapillaryImage {
  id: string;
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
}

interface MapillaryImagesResponse {
  data: MapillaryImage[];
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/tiles/:z/:x/:y", async (req, reply) => {
    const token = ctx.config.accessToken as string | undefined;
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
    const contentType =
      upstream.headers.get("content-type") ?? "application/vnd.mapbox-vector-tile";
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.type(contentType);
    reply.send(Buffer.from(bytes));
  });

  ctx.registerRoute("GET", "/streetview/images", async (req, reply) => {
    const token = ctx.config.accessToken as string | undefined;
    if (!token) {
      reply.status(503).send({ message: "Mapillary token not configured" });
      return;
    }

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    // Mapillary's /images endpoint rejects (HTTP 500
    // "Please reduce the amount of data you're asking for")
    // anything wider than ~0.0002 deg per side as of 2026, so every attempt
    // — initial and widened — must stay below that.
    const DELTAS = [0.0001, 0.00015, 0.0002];

    let images: MapillaryImage[] = [];
    for (const delta of DELTAS) {
      const west = lng - delta;
      const south = lat - delta;
      const east = lng + delta;
      const north = lat + delta;

      const url = `https://graph.mapillary.com/images?bbox=${west},${south},${east},${north}&fields=id,geometry&access_token=${token}&limit=20`;

      const data = await fetchJson<MapillaryImagesResponse>(url, { nullOnError: true });
      if (!data) {
        ctx.log.warn("Mapillary API unreachable or returned an error");
        reply.status(502).send({ message: "Mapillary API error" });
        return;
      }

      if (data.data?.length) {
        images = data.data;
        break;
      }
    }

    const firstImage = images[0];
    if (!firstImage) {
      reply.status(404).send({ message: "No images found near this location" });
      return;
    }

    let nearest = firstImage;
    let minDist = Infinity;

    for (const image of images) {
      const [imgLng, imgLat] = image.geometry.coordinates;
      const dist = Math.hypot(imgLng - lng, imgLat - lat);
      if (dist < minDist) {
        minDist = dist;
        nearest = image;
      }
    }

    reply.send({ id: nearest.id });
  });
}
