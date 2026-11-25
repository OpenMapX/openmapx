import type { FastifyInstance } from "fastify";
import { jobRunner, RetainedJobConflict } from "../services/job-runner";
import { writeAuditLog } from "../utils/audit-log";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";
export async function adminStandaloneIntegrationsRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("onRequest", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  registerIntegrationAdminRoute(app, "listAdminStandaloneIntegrations", async () =>
    (await import("../services/standalone-integrations/ownership")).standaloneInventory(),
  );
  registerIntegrationAdminRoute(app, "removeAdminStandaloneIntegration", async (request, reply) => {
    try {
      const actorId = getAdminSession(request).user.id;
      const accepted = await jobRunner.enqueueStandalone(
        "standalone.remove",
        { integrationId: request.params.id, ...request.body },
        actorId,
        String(request.headers["idempotency-key"]),
      );
      await writeAuditLog({
        actorId,
        action: "standalone.remove",
        targetId: request.params.id,
        details: { jobId: accepted.jobId },
        request,
      });
      return reply.code(202).send(accepted);
    } catch (error) {
      if (error instanceof RetainedJobConflict)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  for (const id of [
    "previewAdminStandaloneIntegration",
    "installAdminStandaloneIntegration",
  ] as const) {
    registerIntegrationAdminRoute(app, id, async (request, reply) => {
      try {
        const actorId = getAdminSession(request).user.id;
        const type =
          id === "previewAdminStandaloneIntegration" ? "standalone.preview" : "standalone.install";
        const accepted = await jobRunner.enqueueStandalone(
          type,
          request.body,
          actorId,
          String(request.headers["idempotency-key"]),
        );
        await writeAuditLog({
          actorId,
          action: type,
          targetId: accepted.operationId,
          details: { jobId: accepted.jobId },
          request,
        });
        return reply.code(202).send(accepted);
      } catch (error) {
        if (error instanceof RetainedJobConflict)
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    });
  }
}
