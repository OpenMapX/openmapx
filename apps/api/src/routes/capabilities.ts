import type { FastifyPluginAsync } from "fastify";
import { serviceRegistry } from "../services/service-registry.js";

export const capabilitiesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/capabilities", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send({ services: serviceRegistry.getAll() });
  });
};
