import {
  effectiveProviderOrder,
  ORCHESTRATOR_BY_DOMAIN,
  type ProviderDomain,
  UNLISTED_BY_DOMAIN,
} from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { getIntegrationsByDomain, getProviderOrder } from "../integration-host";
import { getIntegrationDisplayName } from "../services/integration-credential-status";
import { requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

/** Reads the operator's provider order; it is written through the orchestrator's config. */
export async function adminProviderOrderRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("onRequest", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  registerIntegrationAdminRoute(app, "getAdminProviderOrder", async () => ({
    domains: (Object.keys(ORCHESTRATOR_BY_DOMAIN) as ProviderDomain[]).flatMap((domain) => {
      const orchestratorId = ORCHESTRATOR_BY_DOMAIN[domain];
      if (orchestratorId === null) return [];
      const stored = getProviderOrder(domain);
      const serving = getIntegrationsByDomain(domain);
      const byId = new Map(serving.map((integration) => [integration.id, integration]));
      return [
        {
          domain,
          orchestratorId,
          unlisted: UNLISTED_BY_DOMAIN[domain],
          stored: [...stored],
          effective: effectiveProviderOrder(stored, serving, domain).flatMap(
            ({ integrationId, listed }) => {
              const integration = byId.get(integrationId);
              return integration
                ? [
                    {
                      integrationId,
                      name: getIntegrationDisplayName(integration),
                      isBuiltIn: integration.isBuiltIn,
                      listed,
                    },
                  ]
                : [];
            },
          ),
        },
      ];
    }),
  }));
}
