import type { FastifyInstance } from "fastify";
import { getSafeMode, isSafeModeActive, leaveSafeMode, SafeModeForcedError } from "../safe-mode";
import { writeAuditLog } from "../utils/audit-log";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

/** Reads safe mode, and leaves it unless the environment forces it. */
export async function adminSafeModeRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("onRequest", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  registerIntegrationAdminRoute(app, "getAdminSafeMode", async () => getSafeMode());

  registerIntegrationAdminRoute(app, "leaveAdminSafeMode", async (request, reply) => {
    const before = getSafeMode();
    try {
      return await leaveSafeMode();
    } catch (error) {
      if (error instanceof SafeModeForcedError)
        return reply.code(409).send({ error: error.message });
      throw error;
    } finally {
      // Recorded once safe mode is left, also when the reload that follows fails.
      if (before.active && !isSafeModeActive())
        await writeAuditLog({
          actorId: getAdminSession(request).user.id,
          action: "safe_mode.leave",
          details: { reason: before.reason, integrationId: before.integrationId },
          request,
        });
    }
  });
}
