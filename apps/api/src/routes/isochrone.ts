import type { FastifyPluginAsync } from "fastify";
import { getIsochroneProvider } from "../services/isochrone/factory.js";
import type { IsochroneTravelMode } from "../services/isochrone/provider.js";
import { hashKey, round, TTL, withCache } from "../utils/cache.js";

const MAX_CONTOURS = 4;
const VALID_MODES = new Set<IsochroneTravelMode>(["driving", "walking", "cycling"]);

export const isochroneRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { lat: string; lng: string; mode: string; contours: string };
  }>("/isochrone", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng", "mode", "contours"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          mode: { type: "string" },
          contours: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const lat = Number.parseFloat(req.query.lat);
      const lng = Number.parseFloat(req.query.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.status(400).send({ error: "lat and lng must be valid numbers" });
      }

      const mode = req.query.mode as IsochroneTravelMode;
      if (!VALID_MODES.has(mode)) {
        return reply
          .status(400)
          .send({ error: `Invalid mode. Valid: ${[...VALID_MODES].join(", ")}` });
      }

      const contourMinutes = req.query.contours
        .split(",")
        .map((s) => Number.parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (contourMinutes.length === 0) {
        return reply
          .status(400)
          .send({ error: "contours must contain at least one positive number" });
      }

      if (contourMinutes.length > MAX_CONTOURS) {
        return reply.status(400).send({ error: `Maximum ${MAX_CONTOURS} contours per request` });
      }

      const sorted = [...contourMinutes].sort((a, b) => a - b);

      const key = hashKey("cache:isochrone", {
        lat: round(lat, 3),
        lng: round(lng, 3),
        mode,
        contours: sorted,
      });

      try {
        const result = await withCache(key, TTL.isochrone, () =>
          getIsochroneProvider().isochrone([lng, lat], mode, sorted),
        );
        reply.header("Cache-Control", "public, max-age=3600");
        return result;
      } catch (err) {
        req.log.error(err, "isochrone upstream failed");
        reply.header("Cache-Control", "no-cache");
        return reply.status(502).send({ error: "Isochrone service unavailable" });
      }
    },
  });
};
