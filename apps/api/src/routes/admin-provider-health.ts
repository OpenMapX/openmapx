import type { FastifyInstance } from "fastify";
import { getProviderHealth } from "../services/provider-health/registry";
import { writeAuditLog } from "../utils/audit-log";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerServiceAdminRoute } from "./admin-service-contract";

/**
 * `/api/admin/providers*`: the API's persistent (Redis) health record for each
 * upstream provider. Administrators list all providers, inspect one and reset
 * its sliding window.
 */
export async function adminProviderHealthRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("onRequest", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  registerServiceAdminRoute(app, "listAdminProviderHealth", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const health = getProviderHealth();
    if (!health) return { providers: [] };
    const all = await health.getAll();
    const providers = Object.entries(all)
      .map(([id, state]) => ({ id, ...state }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { providers };
  });

  registerServiceAdminRoute(app, "getAdminProviderHealth", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const state = await getProviderHealth()?.getState(request.params.id);
    if (!state) return reply.code(404).send({ error: "Provider not found" });
    return { id: request.params.id, ...state };
  });

  registerServiceAdminRoute(app, "resetAdminProviderHealth", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const health = getProviderHealth();
    if (!health) {
      return reply.code(503).send({ error: "Provider health tracker not initialised" });
    }
    await health.reset(request.params.id);
    await writeAuditLog({
      actorId: getAdminSession(request).user.id,
      targetId: request.params.id,
      action: "provider.reset",
      request,
    });
    return { ok: true as const, providerId: request.params.id };
  });
}
