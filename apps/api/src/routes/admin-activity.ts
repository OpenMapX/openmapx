import { activityAdminOperations } from "@openmapx/core/api-contracts";
import type { FastifyInstance } from "fastify";
import { getActivityJob, listActivityJobs } from "../services/activity-jobs";
import { jobRunner } from "../services/job-runner";
import { writeAuditLog } from "../utils/audit-log";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { createAdminRouteRegistrar } from "./admin-contract";

export const registerActivityAdminRoute = createAdminRouteRegistrar(activityAdminOperations, {
  tag: "activity-admin",
  validationPhase: "preHandler",
});

export async function adminActivityRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  registerActivityAdminRoute(app, "listAdminActivityJobs", async (request) =>
    listActivityJobs({
      filter: request.query.status,
      limit: request.query.limit,
      offset: request.query.offset,
    }),
  );
  registerActivityAdminRoute(app, "getAdminActivityJob", async (request, reply) => {
    const job = await getActivityJob(request.params.id, request.query.source ?? "application");
    if (!job) return reply.status(404).send({ error: "Job not found" });
    return job;
  });
  registerActivityAdminRoute(app, "cancelAdminActivityJob", async (request, reply) => {
    if (request.query.source === "data-manager")
      return reply.status(400).send({ error: "Data-manager jobs cannot be canceled" });
    const adminSession = getAdminSession(request);
    if (!(await jobRunner.cancel(request.params.id)))
      return reply.status(400).send({ error: "Job cannot be canceled (not running or queued)" });
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetId: request.params.id,
      targetType: "job",
      action: "job.cancel",
      request,
    });
    return { ok: true };
  });
}
