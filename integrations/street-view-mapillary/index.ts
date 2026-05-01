import type { IntegrationContext } from "@openmapx/core";

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

      let response: Response;
      try {
        response = await fetch(url);
      } catch (err) {
        ctx.log.warn("Mapillary API unreachable", err as Error);
        reply.status(502).send({ message: "Mapillary API unreachable" });
        return;
      }

      if (!response.ok) {
        ctx.log.warn(`Mapillary API returned ${response.status}`);
        reply.status(502).send({ message: "Mapillary API error" });
        return;
      }

      const data = (await response.json()) as MapillaryImagesResponse;
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
