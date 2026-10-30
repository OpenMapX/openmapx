import type { FastifyInstance, FastifyReply } from "fastify";
import { hostControlConfigured } from "../services/deployment-mode";
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

const SYSTEM_UPDATE_BODY_KEYS = new Set([
  "confirmation",
  "createBackup",
  "releaseId",
  "expectedDigest",
]);
function isExactSystemUpdateBody(body: unknown): boolean {
  if (!hasOnlyBodyKeys(body, SYSTEM_UPDATE_BODY_KEYS)) return false;
  const value = body as Record<string, unknown> | undefined;
  return (
    value?.confirmation === SYSTEM_UPDATE_CONFIRMATION &&
    typeof value.releaseId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.releaseId) &&
    typeof value.expectedDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.expectedDigest) &&
    (value.createBackup === undefined || typeof value.createBackup === "boolean")
  );
}

const HOST_MUTATING_JOB_TYPES = [
  "system.update",
  "platform.apply",
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

export async function adminSystemRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  app.get(
    "/admin/system",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              deployment: { type: "object", additionalProperties: true },
              images: { type: "array", items: { type: "object", additionalProperties: true } },
              release: {
                type: "object",
                additionalProperties: false,
                properties: {
                  configuredSelector: { type: "string" },
                  currentReleaseId: { type: "string" },
                  availableReleaseId: { type: "string" },
                  currentVersion: { type: "string" },
                  availableVersion: { type: "string" },
                  availableDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = requestIdentity(request);
      const { deployment, inspection } = await deploymentState(identity);
      return reply.send({
        deployment,
        images: coreImages(inspection.services),
        release: inspection.release,
      });
    },
  );

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
    Body: {
      confirmation?: unknown;
      createBackup?: unknown;
      releaseId?: unknown;
      expectedDigest?: unknown;
    };
  }>(
    "/admin/system/updates/apply",
    {
      // Fastify's default Ajv settings remove unknown keys and coerce scalar types.
      // Inspect the original JSON first so the declared strict boundary is real.
      preValidation: async (request, reply) => {
        if (!isExactSystemUpdateBody(request.body))
          return reply.code(400).send({
            error:
              "Provide confirmation, the exact checked releaseId/expectedDigest, and an optional boolean createBackup; other fields are unsupported",
          });
      },
      preHandler: [systemMaintenanceLimit.preHandler()],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["confirmation", "releaseId", "expectedDigest"],
          properties: {
            confirmation: { type: "string", const: SYSTEM_UPDATE_CONFIRMATION },
            createBackup: { type: "boolean" },
            releaseId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
            expectedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      if (
        !hasOnlyBodyKeys(
          request.body,
          new Set(["confirmation", "createBackup", "releaseId", "expectedDigest"]),
        )
      ) {
        reply.status(400);
        return { error: "Request contains unsupported fields" };
      }
      if (request.body?.confirmation !== SYSTEM_UPDATE_CONFIRMATION) {
        reply.status(400);
        return { error: `confirmation must equal "${SYSTEM_UPDATE_CONFIRMATION}"` };
      }
      if (
        typeof request.body?.releaseId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.body.releaseId) ||
        typeof request.body?.expectedDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.body.expectedDigest)
      ) {
        reply.status(400);
        return { error: "Check a release and provide its exact releaseId and expectedDigest" };
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
      if (admin.user.id === "loopback" || admin.session.impersonatedBy)
        return reply.code(403).send({ error: "A real full administrator session is required" });
      const createBackup = request.body?.createBackup !== false;
      const jobId = await jobRunner.enqueue(
        "system.update",
        {
          operation: "apply",
          workflow: "guarded-release",
          createBackup,
          releaseId: request.body.releaseId,
          expectedDigest: request.body.expectedDigest,
        },
        admin.user.id,
      );
      await writeAuditLog({
        actorId: admin.user.id,
        targetType: "system",
        targetId: "openmapx",
        action: "system.update.apply",
        details: {
          createBackup,
          releaseId: request.body.releaseId,
          expectedDigest: request.body.expectedDigest,
        },
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
