import { existsSync } from "node:fs";
import { repoPaths } from "@openmapx/core/server";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isDockerAvailable } from "../services/admin-ops";
import { jobRunner } from "../services/job-runner";
import { getCoreImageStatuses } from "../services/system-maintenance";
import { writeAuditLog } from "../utils/audit-log";
import { systemMaintenanceLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";

export const SYSTEM_UPDATE_CONFIRMATION = "UPDATE OPENMAPX";

const HOST_MUTATING_JOB_TYPES = [
  "system.update",
  "system.diagnostics",
  "service.start",
  "service.stop",
  "service.restart",
  "service.apply",
  "service.bulk",
  "data.operation",
  "backup.operation",
  "extension.install",
  "extension.remove",
] as const;

async function deploymentState() {
  const dockerAvailable = await isDockerAvailable();
  const composeRendered = existsSync(repoPaths().composeOutPath);
  const hostDir = process.env.OPENMAPX_HOST_DIR?.trim() ?? null;
  const hostControlConfigured = Boolean(hostDir && existsSync(hostDir));
  const maintenanceReady =
    dockerAvailable &&
    composeRendered &&
    (hostControlConfigured || process.env.NODE_ENV !== "production");
  return {
    dockerAvailable,
    composeRendered,
    hostControlConfigured,
    maintenanceReady,
  };
}

async function rejectUnavailable(reply: FastifyReply) {
  const deployment = await deploymentState();
  if (deployment.maintenanceReady) return null;
  reply.status(409);
  return {
    error:
      "Host maintenance is unavailable. Docker, a rendered compose file, and the configured host checkout mount are required.",
    deployment,
  };
}

async function activeMaintenanceJob() {
  const active = await Promise.all(
    HOST_MUTATING_JOB_TYPES.map((type) => jobRunner.findActive(type)),
  );
  return active.find((job) => job !== null) ?? null;
}

export async function adminSystemRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  app.get("/admin/system", async (_request, reply) => {
    const deployment = await deploymentState();
    const images = deployment.composeRendered ? await getCoreImageStatuses() : [];
    return reply.send({ deployment, images });
  });

  app.post(
    "/admin/system/updates/check",
    { preHandler: [systemMaintenanceLimit.preHandler()] },
    async (request, reply) => {
      const unavailable = await rejectUnavailable(reply);
      if (unavailable) return unavailable;
      const active = await activeMaintenanceJob();
      if (active) {
        reply.status(409);
        return { error: "A maintenance operation is already active", jobId: active.id };
      }
      const admin = getAdminSession(request);
      const jobId = await jobRunner.enqueue("system.update", { operation: "check" }, admin.user.id);
      await writeAuditLog({
        actorId: admin.user.id,
        targetType: "system",
        targetId: "openmapx",
        action: "system.update.check",
        request,
      });
      return { ok: true, jobId };
    },
  );

  app.post<{
    Body: { confirmation?: unknown; createBackup?: unknown };
  }>(
    "/admin/system/updates/apply",
    { preHandler: [systemMaintenanceLimit.preHandler()] },
    async (request, reply) => {
      if (request.body?.confirmation !== SYSTEM_UPDATE_CONFIRMATION) {
        reply.status(400);
        return { error: `confirmation must equal "${SYSTEM_UPDATE_CONFIRMATION}"` };
      }
      if (
        request.body?.createBackup !== undefined &&
        typeof request.body.createBackup !== "boolean"
      ) {
        reply.status(400);
        return { error: "createBackup must be a boolean" };
      }
      const unavailable = await rejectUnavailable(reply);
      if (unavailable) return unavailable;
      const active = await activeMaintenanceJob();
      if (active) {
        reply.status(409);
        return { error: "A maintenance operation is already active", jobId: active.id };
      }
      const admin = getAdminSession(request);
      const createBackup = request.body?.createBackup !== false;
      const jobId = await jobRunner.enqueue(
        "system.update",
        { operation: "apply", createBackup },
        admin.user.id,
      );
      await writeAuditLog({
        actorId: admin.user.id,
        targetType: "system",
        targetId: "openmapx",
        action: "system.update.apply",
        details: { createBackup },
        request,
      });
      return { ok: true, jobId };
    },
  );

  app.post(
    "/admin/system/diagnostics",
    { preHandler: [systemMaintenanceLimit.preHandler()] },
    async (request, reply) => {
      const unavailable = await rejectUnavailable(reply);
      if (unavailable) return unavailable;
      const active = await activeMaintenanceJob();
      if (active) {
        reply.status(409);
        return { error: "A maintenance operation is already active", jobId: active.id };
      }
      const admin = getAdminSession(request);
      const jobId = await jobRunner.enqueue("system.diagnostics", {}, admin.user.id);
      await writeAuditLog({
        actorId: admin.user.id,
        targetType: "system",
        targetId: "openmapx",
        action: "system.diagnostics.run",
        request,
      });
      return { ok: true, jobId };
    },
  );
}
