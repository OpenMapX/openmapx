import type { FastifyInstance } from "fastify";
import { transitOrchestrator } from "../../services/transit/orchestrator";
import { type BBoxQuery, bboxProperties, idParamSchema, parseBBox } from "./shared";

interface RoutesQuery extends Partial<BBoxQuery> {
  stop_id?: string;
}

interface RouteStopsQuery {
  hint_stop_id?: string;
}

export async function routesRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/transit/routes
  server.get<{ Querystring: RoutesQuery }>("/transit/routes", {
    schema: {
      querystring: {
        type: "object",
        properties: { stop_id: { type: "string" }, ...bboxProperties },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      if (q.stop_id) {
        const routes = await transitOrchestrator.getRoutesForStop(q.stop_id);
        return routes;
      }
      const bbox = parseBBox(q as BBoxQuery);
      if (!bbox) {
        return reply.status(400).send({ error: "Provide stop_id or valid bbox params" });
      }
      const routes = await transitOrchestrator.getRoutesInBbox(bbox);
      return routes;
    },
  });

  // GET /api/transit/routes/:id
  server.get<{ Params: { id: string } }>("/transit/routes/:id", {
    schema: { params: idParamSchema },
    handler: async (req, reply) => {
      const route = await transitOrchestrator.getRoute(decodeURIComponent(req.params.id));
      if (!route) return reply.status(404).send({ error: "Route not found" });
      return route;
    },
  });

  // GET /api/transit/routes/:id/stops?hint_stop_id=
  server.get<{ Params: { id: string }; Querystring: RouteStopsQuery }>(
    "/transit/routes/:id/stops",
    {
      schema: {
        params: idParamSchema,
        querystring: { type: "object", properties: { hint_stop_id: { type: "string" } } },
      },
      handler: async (req, _reply) => {
        const hintStopId = req.query.hint_stop_id
          ? decodeURIComponent(req.query.hint_stop_id)
          : undefined;
        const stops = await transitOrchestrator.getRouteStops(
          decodeURIComponent(req.params.id),
          hintStopId,
        );
        return stops;
      },
    },
  );

  // GET /api/transit/routes/:id/alerts
  server.get<{ Params: { id: string } }>("/transit/routes/:id/alerts", {
    schema: { params: idParamSchema },
    handler: async (req, reply) => {
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const alerts = await transitOrchestrator.getRouteAlerts(decodeURIComponent(req.params.id));
      return alerts;
    },
  });

  // GET /api/transit/routes/:id/live — vehicles + alerts combined
  server.get<{ Params: { id: string } }>("/transit/routes/:id/live", {
    schema: { params: idParamSchema },
    handler: async (req, reply) => {
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
      const routeId = decodeURIComponent(req.params.id);
      const [vehicles, alerts] = await Promise.all([
        transitOrchestrator.getVehiclePositions(routeId),
        transitOrchestrator.getRouteAlerts(routeId),
      ]);
      return { vehicles, alerts };
    },
  });
}
