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
    const token = ctx.config.MAPILLARY_TOKEN as string | undefined;
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

    const delta = 0.005;
    const west = lng - delta;
    const south = lat - delta;
    const east = lng + delta;
    const north = lat + delta;

    const url = `https://graph.mapillary.com/images?bbox=${west},${south},${east},${north}&fields=id,geometry&access_token=${token}&limit=20`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      reply.status(502).send({ message: "Mapillary API unreachable" });
      return;
    }

    if (!response.ok) {
      ctx.log.warn(`Mapillary API returned ${response.status}`);
      reply.status(502).send({ message: "Mapillary API error" });
      return;
    }

    const data = (await response.json()) as MapillaryImagesResponse;

    const firstImage = data.data?.[0];
    if (!firstImage) {
      reply.status(404).send({ message: "No images found near this location" });
      return;
    }

    let nearest = firstImage;
    let minDist = Infinity;

    for (const image of data.data) {
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
