import type { FastifyPluginAsync } from "fastify";

interface MapillaryImage {
  id: string;
  geometry: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat]
  };
}

interface MapillaryImagesResponse {
  data: MapillaryImage[];
}

export const streetviewRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { lat: string; lng: string };
  }>("/streetview/images", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const token = process.env.MAPILLARY_TOKEN;
      if (!token) {
        return reply.status(503).send({ message: "Mapillary token not configured" });
      }

      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.status(400).send({ message: "Invalid coordinates" });
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
        return reply.status(502).send({ message: "Mapillary API unreachable" });
      }

      if (!response.ok) {
        req.log.warn({ status: response.status }, "Mapillary API returned error");
        return reply.status(502).send({ message: "Mapillary API error" });
      }

      const data = (await response.json()) as MapillaryImagesResponse;

      const firstImage = data.data?.[0];
      if (!firstImage) {
        return reply.status(404).send({ message: "No images found near this location" });
      }

      // Find nearest image by Euclidean distance
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

      return reply.send({ id: nearest.id });
    },
  });
};
