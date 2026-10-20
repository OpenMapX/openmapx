import { adminIntegrationBindingSetSchema } from "@openmapx/core/api-contracts";
import { services as coreServices } from "@openmapx/core/server";
import type { FastifyInstance } from "fastify";
import {
  listBindingsForIntegration,
  removeBinding,
  setBinding,
} from "../services/capability-bindings";
import { getServiceRegistry } from "../services/service-registry";
import { requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

const { getProvidedCapabilityNames } = coreServices;

export async function registerCapabilityBindingRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  app: FastifyInstance<any, any, any, any>,
): Promise<void> {
  await app.register(
    async (child) => {
      declareRouteAuth(child, "admin");
      // Preserve the existing POST framework-body-before-handler-auth boundary.
      child.addHook("preValidation", async (request, reply) => {
        if (
          request.method === "POST" &&
          !adminIntegrationBindingSetSchema.safeParse(request.body).success
        )
          return reply.code(400).send({ error: "Invalid administration body" });
      });

      registerIntegrationAdminRoute(
        child,
        "listAdminIntegrationBindings",
        async (req, _reply) => {
          const rows = await listBindingsForIntegration(req.params.integrationId);
          return { bindings: rows };
        },
        {
          beforeValidation: async (request) => {
            await requireAdmin(request);
          },
        },
      );

      registerIntegrationAdminRoute(
        child,
        "setAdminIntegrationBinding",
        async (req, reply) => {
          let registry: ReturnType<typeof getServiceRegistry>;
          try {
            registry = getServiceRegistry();
          } catch {
            reply.status(503);
            return { error: "Service registry not available" };
          }
          const svc = registry.get(req.body.serviceId);
          if (!svc) {
            reply.status(400);
            return { error: `Unknown service: ${req.body.serviceId}` };
          }
          if (!getProvidedCapabilityNames(svc.manifest.provides).includes(req.params.capability)) {
            reply.status(400);
            return {
              error: `Service ${svc.manifest.id} does not provide capability ${req.params.capability}`,
            };
          }
          await setBinding(
            { integrationId: req.params.integrationId, capability: req.params.capability },
            req.body.serviceId,
          );
          return { ok: true };
        },
        {
          beforeValidation: async (request) => {
            await requireAdmin(request);
          },
        },
      );

      registerIntegrationAdminRoute(
        child,
        "deleteAdminIntegrationBinding",
        async (req, _reply) => {
          await removeBinding({
            integrationId: req.params.integrationId,
            capability: req.params.capability,
          });
          return { ok: true };
        },
        {
          beforeValidation: async (request) => {
            await requireAdmin(request);
          },
        },
      );
    },
    { prefix: "/api" },
  );
}
