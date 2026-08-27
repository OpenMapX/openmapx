import type { FastifyInstance, FastifyReply } from "fastify";
import { jobRunner } from "../services/job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../services/ops-client";
import { writeAuditLog } from "../utils/audit-log";
import { systemMaintenanceLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";

export const SYSTEM_UPDATE_CONFIRMATION = "UPDATE OPENMAPX";

function hasOnlyBodyKeys(body: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    body === undefined ||
    (body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).every((key) => allowed.has(key)))
  );
}

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
        hostControlConfigured: inspection.maintenanceReady,
        maintenanceReady: inspection.maintenanceReady,
      },
      inspection,
    };
  } catch {
    return {
      deployment: {
        dockerAvailable: false,
        composeRendered: false,
        hostControlConfigured: false,
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

export async function adminSystemRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  app.get("/admin/system", async (request, reply) => {
    const identity = requestIdentity(request);
    const { deployment, inspection } = await deploymentState(identity);
    return reply.send({
      deployment,
      images: coreImages(inspection.services),
      release: inspection.release,
    });
  });

  app.post(
    "/admin/system/updates/check",
    { preHandler: [systemMaintenanceLimit.preHandler()] },
    async (request, reply) => {
      if (!hasOnlyBodyKeys(request.body, new Set())) {
        reply.status(400);
        return { error: "Request contains unsupported fields" };
      }
      const unavailable = await rejectUnavailable(request, reply);
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
      if (!hasOnlyBodyKeys(request.body, new Set(["confirmation", "createBackup"]))) {
        reply.status(400);
        return { error: "Request contains unsupported fields" };
      }
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
      const unavailable = await rejectUnavailable(request, reply);
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
      if (!hasOnlyBodyKeys(request.body, new Set())) {
        reply.status(400);
        return { error: "Request contains unsupported fields" };
      }
      const unavailable = await rejectUnavailable(request, reply);
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
