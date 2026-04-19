import { toIntegrationMeta } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { getAllIntegrations } from "../integration-host.js";
import { isIntegrationHealthy } from "../services/integration-health.js";

export const capabilitiesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/capabilities", async (_req, reply) => {
    const services: Record<
      string,
      {
        enabled: boolean;
        healthy: boolean;
        available: boolean;
        domains: string[];
      }
    > = {};

    for (const integration of getAllIntegrations()) {
      const meta = toIntegrationMeta(integration);
      const healthy = isIntegrationHealthy(integration.id, !!integration.manifest.healthCheck);
      services[integration.id] = {
        enabled: meta.enabled,
        healthy,
        available: meta.enabled && (healthy || !integration.manifest.healthCheck),
        domains: meta.domains,
      };
    }

    reply.header("Cache-Control", "public, max-age=60");
    return reply.send({ services });
  });
};
