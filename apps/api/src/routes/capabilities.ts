import type { FastifyPluginAsync } from "fastify";
import { getAllIntegrations } from "../integration-host.js";

export const capabilitiesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/capabilities", async (_req, reply) => {
    const services: Record<string, boolean> = {};

    for (const integration of getAllIntegrations()) {
      if (!integration.enabled) {
        services[integration.id] = false;
        continue;
      }
      const envVars = integration.manifest.envVars as string[] | undefined;
      const allSet =
        !envVars?.length ||
        envVars.every((v) => {
          const val = process.env[v];
          return val !== undefined && val !== "";
        });
      services[integration.id] = allSet;
    }

    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send({ services });
  });
};
