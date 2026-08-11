import { toIntegrationMeta } from "@openmapx/integration-framework";
import type { FastifyPluginAsync } from "fastify";
import { getAllIntegrations } from "../integration-host.js";
import { isIntegrationHealthy } from "../services/integration-health.js";
import { osmContributionsPubliclyEnabled } from "../utils/osm-config.js";
import { declareRouteAuth } from "../utils/route-auth.js";

export const capabilitiesRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

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
    // A bounded feature bit so a signed-out client can hide unreleased UI.
    // It reflects only the master flag and OAuth configuration — never the
    // direct-write kill switch and never a person's linked-account state.
    return reply.send({
      services,
      features: { osmContributions: osmContributionsPubliclyEnabled() },
    });
  });
};
