import type { FastifyInstance } from "fastify";
import { transitOrchestrator } from "../../services/transit/orchestrator";
import { type BBoxQuery, bboxProperties, idParamSchema, parseBBox } from "./shared";

interface VehiclesQuery extends Partial<BBoxQuery> {
  route_id?: string;
}

interface VehicleByIdQuery {
  fallback_ids?: string;
}

export async function vehiclesRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/transit/vehicles?route_id= OR ?sw_lat=&sw_lng=&ne_lat=&ne_lng= (radar)
  server.get<{ Querystring: VehiclesQuery }>("/transit/vehicles", {
    schema: {
      querystring: {
        type: "object",
        properties: { route_id: { type: "string" }, ...bboxProperties },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15");

      if (q.route_id) {
        const vehicles = await transitOrchestrator.getVehiclePositions(q.route_id);
        return vehicles;
      }

      const bbox = parseBBox(q as BBoxQuery);
      if (bbox) {
        const vehicles = await transitOrchestrator.getVehicleRadar(bbox);
        return vehicles;
      }

      return reply
        .status(400)
        .send({ error: "Provide route_id or valid bbox params (sw_lat, sw_lng, ne_lat, ne_lng)" });
    },
  });

  // GET /api/transit/vehicles/:id?fallback_ids=id1,id2
  server.get<{ Params: { id: string }; Querystring: VehicleByIdQuery }>("/transit/vehicles/:id", {
    schema: {
      params: idParamSchema,
      querystring: { type: "object", properties: { fallback_ids: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const fallbackIds = req.query.fallback_ids
        ? req.query.fallback_ids.split(",").map((s) => decodeURIComponent(s.trim()))
        : undefined;
      const journey = await transitOrchestrator.getVehicleJourney(
        decodeURIComponent(req.params.id),
        fallbackIds,
      );
      if (!journey) return reply.status(404).send({ error: "Vehicle journey not found" });
      return journey;
    },
  });
}
