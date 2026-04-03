import { registry } from "@integrations/transit-dynamic-registry/registry";
import { getFeedProviders } from "@integrations/transit-motis/index.js";
import type { FastifyInstance } from "fastify";
import { getTransitProviderAttribution } from "../../integration-host";
import { transitOrchestrator } from "../../services/transit/orchestrator";

export async function metaRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/transit/providers — merged attribution map (static + dynamic registry)
  server.get("/transit/providers", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
    const result: Record<
      string,
      { label: string; url: string; license?: string; licenseUrl?: string }
    > = {
      ...getTransitProviderAttribution(),
      ...getFeedProviders(),
    };
    for (const { slug, label, url } of registry.listProviders()) {
      if (!result[slug]) result[slug] = { label, url };
    }
    return result;
  });

  // GET /api/transit/health — provider health status (debug)
  server.get("/transit/health", async () => {
    return { providers: transitOrchestrator.getHealthStatus() };
  });
}
