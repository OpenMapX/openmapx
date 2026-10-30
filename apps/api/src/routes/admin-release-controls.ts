import type { FastifyInstance } from "fastify";
import { parseDirectOpsIdempotency } from "../services/direct-ops-idempotency";
import { jobRunner } from "../services/job-runner";
import { MaintenanceRequestConflict } from "../services/retained-maintenance-job";
import { writeAuditLog } from "../utils/audit-log";
import { RateLimiter } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerServiceAdminRoute } from "./admin-service-contract";
export async function adminReleaseControlsRoute(app: FastifyInstance) {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  const limit = new RateLimiter({
    max: 12,
    windowMs: 60000,
    keyFn: (request) => getAdminSession(request).user.id,
  });
  app.addHook("onClose", async () => limit.destroy());
  registerServiceAdminRoute(
    app,
    "clearAdminReleaseSelection",
    async (request, reply) => {
      const actor = getAdminSession(request).user.id;
      try {
        const jobId = await jobRunner.enqueueMaintenance(
          "release.clear",
          request.body,
          actor,
          parseDirectOpsIdempotency(request.headers["idempotency-key"]),
        );
        await writeAuditLog({
          actorId: actor,
          action: "release.clear",
          targetType: "release",
          targetId: request.body.expectedReleaseId,
          details: { jobId },
          request,
        });
        return reply.code(202).send({ ok: true, jobId });
      } catch (error) {
        if (error instanceof MaintenanceRequestConflict)
          return reply.code(409).send({ error: "Mutation key belongs to another request" });
        return reply.code(503).send({
          error:
            "Release pin clearing is unavailable; inspect Activity before retrying the same request",
        });
      }
    },
    { preHandler: limit.preHandler() },
  );
}
