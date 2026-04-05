import type { FastifyInstance } from "fastify";
import { transitOrchestrator } from "../../services/transit/orchestrator";
import { type BBoxQuery, bboxProperties, bboxRequired, parseBBox } from "./shared";

export async function alertsRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/transit/alerts
  server.get<{ Querystring: BBoxQuery }>("/transit/alerts", {
    schema: {
      querystring: {
        type: "object",
        required: [...bboxRequired],
        properties: { ...bboxProperties },
      },
    },
    handler: async (req, reply) => {
      const bbox = parseBBox(req.query);
      if (!bbox) return reply.status(400).send({ error: "Invalid or missing bbox params" });
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const alerts = await transitOrchestrator.getAlerts(bbox);
      return alerts;
    },
  });
}
