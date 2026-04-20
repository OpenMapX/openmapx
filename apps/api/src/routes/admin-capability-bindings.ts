import { services as coreServices } from "@openmapx/core/server";
import type { FastifyInstance } from "fastify";
import {
  listBindingsForIntegration,
  removeBinding,
  setBinding,
} from "../services/capability-bindings";
import { getServiceRegistry } from "../services/service-registry";
import { requireAdmin } from "../utils/require-admin";

const { getProvidedCapabilityNames } = coreServices;

export async function registerCapabilityBindingRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  app: FastifyInstance<any, any, any, any>,
): Promise<void> {
  app.get<{ Params: { integrationId: string } }>(
    "/api/admin/integrations/:integrationId/bindings",
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;
      const rows = await listBindingsForIntegration(req.params.integrationId);
      return { bindings: rows };
    },
  );

  app.post<{
    Params: { integrationId: string; capability: string };
    Body: { serviceId: string };
  }>("/api/admin/integrations/:integrationId/bindings/:capability", async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const registry = getServiceRegistry();
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
  });

  app.delete<{ Params: { integrationId: string; capability: string } }>(
    "/api/admin/integrations/:integrationId/bindings/:capability",
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;
      await removeBinding({
        integrationId: req.params.integrationId,
        capability: req.params.capability,
      });
      return { ok: true };
    },
  );
}
