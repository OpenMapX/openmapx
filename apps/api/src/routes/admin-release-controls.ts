import type { FastifyInstance } from "fastify";
import { parseDirectOpsIdempotency } from "../services/direct-ops-idempotency";
import { jobRunner } from "../services/job-runner";
import { MaintenanceRequestConflict } from "../services/retained-maintenance-job";
import { getServiceRegistry } from "../services/service-registry";
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
    "pullAdminServiceImages",
    async (request, reply) => {
      const actor = getAdminSession(request).user.id;
      let known: boolean;
      try {
        const registry = getServiceRegistry();
        known = request.body.serviceIds.every((id) => Boolean(registry.get(id)?.enabled));
      } catch {
        return reply.code(503).send({ error: "Service registry is unavailable" });
      }
      if (!known) return reply.code(400).send({ error: "Select installed, enabled services" });
      try {
        const jobId = await jobRunner.enqueueMaintenance(
          "service.images.pull",
          request.body,
          actor,
          parseDirectOpsIdempotency(request.headers["idempotency-key"]),
        );
        await writeAuditLog({
          actorId: actor,
          action: "service.images.pull",
          targetType: "service",
          targetId: null,
          details: { jobId, serviceIds: request.body.serviceIds },
          request,
        });
        return reply.code(202).send({ ok: true, jobId });
      } catch (error) {
        if (error instanceof MaintenanceRequestConflict)
          return reply.code(409).send({ error: "Mutation key belongs to another request" });
        return reply.code(503).send({
          error: "Image staging is unavailable; inspect Activity before retrying the same request",
        });
      }
    },
    { preHandler: limit.preHandler() },
  );
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
