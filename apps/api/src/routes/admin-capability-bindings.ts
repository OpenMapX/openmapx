import {
  adminIntegrationBindingDeleteSchema,
  adminIntegrationBindingSetSchema,
} from "@openmapx/core/api-contracts";
import { services as coreServices } from "@openmapx/core/server";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { integrationApplicationReceipt } from "../db/schema";
import { getIntegration, inspectIntegrationRuntime } from "../integration-host";
import { AdminJobFailure, JobObservationPending } from "../services/admin-job-failure";
import { withAdministrativeConfigurationRead } from "../services/administrative-configuration-writer";
import {
  createDirectAdminOpsKey,
  parseDirectOpsIdempotency,
} from "../services/direct-ops-idempotency";
import { IntegrationBindingConflict } from "../services/integration-binding-participant";
import { capturedBindingState } from "../services/integration-binding-state";
import { jobRunner } from "../services/job-runner";
import { getServiceRegistry } from "../services/service-registry";
import { serviceActionLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

export async function registerCapabilityBindingRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (child) => {
      declareRouteAuth(child, "admin");
      child.addHook("preValidation", async (request, reply) => {
        const schema =
          request.method === "POST"
            ? adminIntegrationBindingSetSchema
            : request.method === "DELETE"
              ? adminIntegrationBindingDeleteSchema
              : null;
        if (schema && !schema.safeParse(request.body).success)
          return reply.code(400).send({ error: "Invalid administration body" });
      });
      const guard = {
        beforeValidation: async (
          request: Parameters<typeof requireAdmin>[0],
          reply: Parameters<ReturnType<typeof serviceActionLimit.preHandler>>[1],
        ) => {
          request.adminSession = await requireAdmin(request);
          await serviceActionLimit.preHandler()(request, reply);
        },
      };
      registerIntegrationAdminRoute(
        child,
        "listAdminIntegrationBindings",
        async (req) =>
          withAdministrativeConfigurationRead({}, async (read) => {
            const desired = capturedBindingState(read, req.params.integrationId),
              [last] = await db
                .select({ result: integrationApplicationReceipt.result })
                .from(integrationApplicationReceipt)
                .where(eq(integrationApplicationReceipt.integrationId, req.params.integrationId))
                .orderBy(desc(integrationApplicationReceipt.createdAt))
                .limit(1);
            return {
              bindings: Object.entries(desired.bindings).map(([capability, serviceId]) => ({
                capability,
                serviceId,
              })),
              revision: desired.revision,
              desiredRevision: desired.desiredRevision,
              runtime: inspectIntegrationRuntime(req.params.integrationId),
              lastApplication: last?.result ?? null,
            };
          }),
        {
          beforeValidation: async (request) => {
            request.adminSession = await requireAdmin(request);
          },
        },
      );
      const apply = async (
        req: {
          params: { integrationId: string; capability: string };
          body: { expectedServiceId: string | null; expectedRevision: string; serviceId?: string };
          headers: Record<string, unknown>;
        },
        actorId: string,
      ) => {
        const integration = getIntegration(req.params.integrationId);
        if (
          !integration?.manifest.requires?.some(
            (entry) => entry.capability === req.params.capability,
          )
        )
          throw new IntegrationBindingConflict("BINDING_CAPABILITY_NOT_DECLARED");
        if (req.body.serviceId) {
          let registry: ReturnType<typeof getServiceRegistry>;
          try {
            registry = getServiceRegistry();
          } catch {
            throw new JobObservationPending("transport");
          }
          const service = registry.get(req.body.serviceId);
          if (
            !service?.enabled ||
            !coreServices
              .getProvidedCapabilityNames(service.manifest.provides)
              .includes(req.params.capability)
          )
            throw new IntegrationBindingConflict("BINDING_SERVICE_UNAVAILABLE");
        }
        return jobRunner.applyImmediateIntegrationBinding({
          actorId,
          operationKey: createDirectAdminOpsKey(
            actorId,
            parseDirectOpsIdempotency(req.headers["idempotency-key"]),
          ),
          input: { ...req.params, ...req.body, serviceId: req.body.serviceId ?? null },
        });
      };
      const errors = (
        error: unknown,
        reply: { code: (status: number) => { send: (body: { error: string }) => unknown } },
      ) => {
        if (error instanceof IntegrationBindingConflict)
          return reply
            .code(
              error.code === "BINDING_VERSION_CONFLICT" || error.code === "BINDING_SOURCE_CHANGED"
                ? 409
                : 400,
            )
            .send({ error: error.code });
        if (error instanceof AdminJobFailure && error.result.errorCode === "conflict")
          return reply.code(409).send({ error: "Retained binding intent conflicts" });
        if (error instanceof JobObservationPending)
          return reply.code(503).send({
            error:
              "Binding saved or awaiting reconciliation; inspect its operation status before retrying",
          });
        throw error;
      };
      registerIntegrationAdminRoute(
        child,
        "setAdminIntegrationBinding",
        async (req, reply) => {
          try {
            return await apply(req, getAdminSession(req).user.id);
          } catch (error) {
            return errors(error, reply);
          }
        },
        guard,
      );
      registerIntegrationAdminRoute(
        child,
        "deleteAdminIntegrationBinding",
        async (req, reply) => {
          try {
            return await apply(req, getAdminSession(req).user.id);
          } catch (error) {
            return errors(error, reply);
          }
        },
        guard,
      );
    },
    { prefix: "/api" },
  );
}
