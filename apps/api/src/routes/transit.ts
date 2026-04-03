import type { FastifyInstance } from "fastify";
import { alertsRoutes } from "./transit/alerts";
import { metaRoutes } from "./transit/meta";
import { placeRoutes } from "./transit/place";
import { routesRoutes } from "./transit/routes";
import { stopsRoutes } from "./transit/stops";
import { tripsRoutes } from "./transit/trips";
import { vehiclesRoutes } from "./transit/vehicles";

export async function transitRoute(server: FastifyInstance): Promise<void> {
  // Shared error handler for transit service calls
  server.setErrorHandler(async (error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const message = statusCode >= 500 ? "Internal transit service error" : error.message;
    return reply.status(statusCode).send({ error: message });
  });

  await server.register(stopsRoutes);
  await server.register(placeRoutes);
  await server.register(routesRoutes);
  await server.register(alertsRoutes);
  await server.register(vehiclesRoutes);
  await server.register(tripsRoutes);
  await server.register(metaRoutes);
}
