import { HOST_MUTATING_JOB_TYPES } from "@openmapx/core/api-contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ActiveMaintenanceConflict } from "../services/active-maintenance-conflict";
import { hostControlConfigured } from "../services/deployment-mode";
import { jobRunner } from "../services/job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../services/ops-client";
import { writeAuditLog } from "../utils/audit-log";
import { systemMaintenanceLimit, systemUpdateCheckLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerServiceAdminRoute } from "./admin-service-contract";

async function deploymentState(durableIdentity: string) {
  try {
    const inspection = await executeAndWait(
      createApiOpsClient(),
      { kind: "system.inspect" },
      createDurableOpsKey("admin.system.inspect", durableIdentity),
      { signal: AbortSignal.timeout(30_000) },
    );
    return {
      deployment: {
        dockerAvailable: inspection.dockerReachable,
        composeRendered: inspection.composeReady,
        hostControlConfigured: hostControlConfigured(),
        maintenanceReady: inspection.maintenanceReady,
      },
      inspection,
    };
  } catch {
    return {
      deployment: {
        dockerAvailable: false,
        composeRendered: false,
        hostControlConfigured: hostControlConfigured(),
        maintenanceReady: false,
      },
      inspection: { release: {}, services: [] },
    };
  }
}

function coreImages(
  services: Awaited<ReturnType<typeof deploymentState>>["inspection"]["services"],
) {
  return services.map((service) => ({
    id: service.serviceId,
    name: service.serviceId,
    image: service.pinnedImage ?? null,
    containerState: service.containerState,
    runningImageId: service.runningImageId ?? null,
    localImageId: service.localImageId ?? null,
    updateAvailable: service.state === "update_available",
    releaseMember: service.releaseMember,
    status:
      service.state === "current"
        ? "up-to-date"
        : service.state === "update_available"
          ? "update-available"
          : service.state === "not_running"
            ? "not-running"
            : "unknown",
  }));
}

function requestIdentity(request: {
  id: string;
  adminSession?: { user?: { id?: string } };
}): string {
  return `${request.adminSession?.user?.id ?? "admin"}:${request.id}`;
}

async function rejectUnavailable(
  request: { id: string; adminSession?: unknown },
  reply: FastifyReply,
) {
  const { deployment } = await deploymentState(requestIdentity(request as never));
  if (deployment.maintenanceReady) return null;
  reply.status(409);
  return {
    error: "Host maintenance is unavailable through the operations agent.",
    deployment,
  };
}

async function activeMaintenanceJob() {
  const active = await Promise.all(
    HOST_MUTATING_JOB_TYPES.map((type) => jobRunner.findActive(type)),
  );
  return active.find((job) => job !== null) ?? null;
}

function maintenanceConflict(reply: FastifyReply, active: { id: string } | null) {
  reply.status(409);
  return { error: "A maintenance operation is already active", jobId: active?.id };
}

/** The pre-check gives the common case a precise answer; the job table's
 * unique active-maintenance index decides concurrent requests. */
async function enqueueMaintenance(
  reply: FastifyReply,
  type: "system.update" | "system.diagnostics",
  payload: Record<string, unknown>,
  actorId: string,
): Promise<{ jobId: string } | { conflict: ReturnType<typeof maintenanceConflict> }> {
  try {
    return { jobId: await jobRunner.enqueue(type, payload, actorId) };
  } catch (error) {
    if (!(error instanceof ActiveMaintenanceConflict)) throw error;
    return { conflict: maintenanceConflict(reply, await activeMaintenanceJob()) };
  }
}

export async function adminSystemRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("onRequest", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  registerServiceAdminRoute(app, "getAdminSystemStatus", async (request) => {
    const { deployment, inspection } = await deploymentState(requestIdentity(request));
    return { deployment, images: coreImages(inspection.services), release: inspection.release };
  });

  registerServiceAdminRoute(
    app,
    "checkAdminSystemUpdates",
    async (request, reply) => {
      const unavailable = await rejectUnavailable(request, reply);
      if (unavailable) return unavailable;
      const active = await activeMaintenanceJob();
      if (active) return maintenanceConflict(reply, active);
      const admin = getAdminSession(request);
      const admitted = await enqueueMaintenance(
        reply,
        "system.update",
        { operation: "check" },
        admin.user.id,
      );
      if ("conflict" in admitted) return admitted.conflict;
      await writeAuditLog({
        actorId: admin.user.id,
        targetType: "system",
        targetId: "openmapx",
        action: "system.update.check",
        request,
      });
      return { ok: true, jobId: admitted.jobId };
    },
    { preHandler: [systemUpdateCheckLimit.preHandler()] },
  );

  registerServiceAdminRoute(
    app,
    "applyAdminSystemUpdate",
    async (request, reply) => {
      const unavailable = await rejectUnavailable(request, reply);
      if (unavailable) return unavailable;
      const active = await activeMaintenanceJob();
      if (active) return maintenanceConflict(reply, active);
      const admin = getAdminSession(request);
      if (admin.user.id === "loopback" || admin.session.impersonatedBy)
        return reply.code(403).send({ error: "A real full administrator session is required" });
      const { releaseId, expectedDigest } = request.body;
      const createBackup = request.body.createBackup !== false;
      const admitted = await enqueueMaintenance(
        reply,
        "system.update",
        {
          operation: "apply",
          workflow: "guarded-release",
          createBackup,
          releaseId,
          expectedDigest,
        },
        admin.user.id,
      );
      if ("conflict" in admitted) return admitted.conflict;
      await writeAuditLog({
        actorId: admin.user.id,
        targetType: "system",
        targetId: "openmapx",
        action: "system.update.apply",
        details: { createBackup, releaseId, expectedDigest },
        request,
      });
      return { ok: true, jobId: admitted.jobId };
    },
    { preHandler: [systemMaintenanceLimit.preHandler()] },
  );

  registerServiceAdminRoute(
    app,
    "runAdminSystemDiagnostics",
    async (request, reply) => {
      const unavailable = await rejectUnavailable(request, reply);
      if (unavailable) return unavailable;
      const active = await activeMaintenanceJob();
      if (active) return maintenanceConflict(reply, active);
      const admin = getAdminSession(request);
      const admitted = await enqueueMaintenance(reply, "system.diagnostics", {}, admin.user.id);
      if ("conflict" in admitted) return admitted.conflict;
      await writeAuditLog({
        actorId: admin.user.id,
        targetType: "system",
        targetId: "openmapx",
        action: "system.diagnostics.run",
        request,
      });
      return { ok: true, jobId: admitted.jobId };
    },
    { preHandler: [systemMaintenanceLimit.preHandler()] },
  );
}
