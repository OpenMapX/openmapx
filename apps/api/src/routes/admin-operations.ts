import type { FastifyInstance } from "fastify";
import type { DataOperationJobPayload } from "../services/admin-job-handlers";
import {
  describeAdminOperationCatalog,
  getAdminOperation,
  parseAdminOperationInput,
} from "../services/admin-operation-catalog";
import { jobRunner } from "../services/job-runner";
import { writeAuditLog } from "../utils/audit-log";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth.js";
import { registerServiceAdminRoute } from "./admin-service-contract";

/**
 * Catalog-driven data operations. The browser renders forms from the served
 * contract, previews the validated effect, and queues a job. Validation for
 * every path comes from the same catalog entry the job handler executes.
 */
export async function adminOperationsRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  registerServiceAdminRoute(app, "listAdminOperations", async () => ({
    operations: describeAdminOperationCatalog(),
  }));

  registerServiceAdminRoute(
    app,
    "previewAdminOperation",
    async (req, reply) => {
      const definition = getAdminOperation(req.params.id);
      if (!definition) {
        reply.status(404);
        return { ok: false, error: "Unknown operation" };
      }
      const parsed = parseAdminOperationInput(definition, req.body);
      if (!parsed.ok) {
        reply.status(400);
        return parsed;
      }
      return {
        ok: true,
        input: parsed.input,
        preview: definition.preview(parsed.input),
        risk: definition.risk,
        ...(definition.confirmation ? { confirmation: definition.confirmation } : {}),
      };
    },
    {
      beforeValidation: async (req, reply) => {
        if (!getAdminOperation((req.params as { id: string }).id))
          return reply.code(404).send({ ok: false, error: "Unknown operation" });
      },
    },
  );

  registerServiceAdminRoute(
    app,
    "runAdminOperation",
    async (req, reply) => {
      const definition = getAdminOperation(req.params.id);
      if (!definition) {
        reply.status(404);
        return { ok: false, error: "Unknown operation" };
      }
      const parsed = parseAdminOperationInput(definition, req.body);
      if (!parsed.ok) {
        reply.status(400);
        return parsed;
      }

      const adminSession = getAdminSession(req);
      const payload: DataOperationJobPayload = {
        operation: definition.id,
        version: definition.version,
        // Keep validated RAW JSON: execution parses/transforms it once again at
        // its own trust boundary (e.g. countries text -> typed countryCodes).
        input: req.body ?? {},
      };
      const jobId = await jobRunner.enqueue("data.operation", { ...payload }, adminSession.user.id);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetType: "data",
        targetId: definition.id,
        action: `data.${definition.id}`,
        details: definition.audit ? definition.audit(parsed.input) : parsed.input,
        request: req,
      });
      return { ok: true, jobId };
    },
    {
      beforeValidation: async (req, reply) => {
        if (!getAdminOperation((req.params as { id: string }).id))
          return reply.code(404).send({ ok: false, error: "Unknown operation" });
      },
    },
  );
}
