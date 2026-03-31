import { toIntegrationMeta } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { getAllIntegrations } from "../integration-host.js";

export const capabilitiesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/capabilities", async (_req, reply) => {
    const services: Record<string, { configured: boolean; enabled: boolean; domains: string[] }> =
      {};

    for (const integration of getAllIntegrations()) {
      const meta = toIntegrationMeta(integration);
      services[integration.id] = {
        configured: meta.configured,
        enabled: meta.enabled,
        domains: meta.domains,
      };
    }

    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send({ services });
  });
};
