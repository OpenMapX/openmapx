import { isRisConfigured } from "@integrations/geocoding-db-ris/ris-client.js";
import type { FastifyPluginAsync } from "fastify";
import { getJourneyGeometry, getTrainPositions } from "../services/db-maps/maps-service.js";

export const risMapsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/ris-maps/positions", async (_req, reply) => {
    if (!isRisConfigured()) {
      return reply.status(503).send({ error: "DB RIS credentials not configured" });
    }
    try {
      const positions = await getTrainPositions();
      reply.header("Cache-Control", "public, max-age=15");
      return positions;
    } catch {
      return reply.status(502).send({ error: "Failed to fetch train positions" });
    }
  });

  fastify.get<{ Querystring: { journey_ids?: string } }>(
    "/ris-maps/geometry",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { journey_ids: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      if (!isRisConfigured()) {
        return reply.status(503).send({ error: "DB RIS credentials not configured" });
      }
      const ids = (req.query.journey_ids ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        return reply.status(400).send({ error: "journey_ids parameter required" });
      }
      try {
        const geojson = await getJourneyGeometry(ids);
        if (!geojson) {
          return reply.status(404).send({ error: "No geometry found" });
        }
        reply.header("Cache-Control", "public, max-age=300");
        return geojson;
      } catch {
        return reply.status(502).send({ error: "Failed to fetch journey geometry" });
      }
    },
  );

  fastify.get("/ris-maps/status", async () => {
    return { available: isRisConfigured() };
  });
};
