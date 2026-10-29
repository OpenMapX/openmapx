import { repoPaths, services } from "@openmapx/core/server";
import type { FastifyInstance } from "fastify";
import { applyGenerationHardlinks, renderAndPersistCompose } from "../services/admin-ops";
import { readDesiredSelection } from "../services/desired-selection";
import {
  createDirectAdminOpsKey,
  DIRECT_OPS_IDEMPOTENCY_HEADER,
  parseDirectOpsIdempotency,
} from "../services/direct-ops-idempotency";
import { getServiceRegistry } from "../services/service-registry";
import { buildConfigurationInput, integrationSchemas } from "../services/trusted-config-operations";
import { dockerComposeAction, STACK_STOP_GUIDANCE } from "../utils/docker-compose";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerServiceAdminRoute } from "./admin-service-contract";

export async function registerAdminComposeRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  app: FastifyInstance<any, any, any, any>,
): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  // GET /api/admin/compose/preview — render generated compose YAML from registry
  registerServiceAdminRoute(app, "getAdminComposePreview", async (_req, reply) => {
    let registry: ReturnType<typeof getServiceRegistry>;
    try {
      registry = getServiceRegistry();
    } catch {
      reply.status(503);
      return { error: "Service registry not available" };
    }
    const desired = await readDesiredSelection();
    const { rendered } = services.renderConfiguration({
      infraDir: repoPaths().infraDir,
      services: registry.list(),
      integrationSchemas: integrationSchemas(),
      input: { ...(await buildConfigurationInput()), selectedRoots: desired.roots },
      allowMissingSelected: desired.source === "default",
    });
    reply.header("Content-Type", "text/yaml; charset=utf-8");
    return rendered.composeYaml;
  });

  // POST /api/admin/compose/up — bring the whole stack up
  registerServiceAdminRoute(
    app,
    "startAdminCompose",
    async (req) => {
      const adminSession = getAdminSession(req);
      const idempotencyValue = parseDirectOpsIdempotency(
        req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER],
      );
      const operationKey = createDirectAdminOpsKey(adminSession.user.id, idempotencyValue);
      const { revisionId } = await renderAndPersistCompose({ operationKey });
      const hardlinks = await applyGenerationHardlinks({
        revisionId,
        operationIdentity: operationKey,
      });
      const r = await dockerComposeAction("", "start", {
        operationKey,
      });
      return { ok: r.exitCode === 0, stdout: r.stdout, hardlinks };
    },
    {
      beforeValidation: async (request, reply) => {
        try {
          parseDirectOpsIdempotency(request.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]);
        } catch (error) {
          return reply.code(400).send({ ok: false, error: (error as Error).message });
        }
      },
    },
  );

  // POST /api/admin/compose/down — stop the whole stack
  registerServiceAdminRoute(app, "stopAdminCompose", async (_req, reply) => {
    reply.code(503);
    return { ok: false, error: STACK_STOP_GUIDANCE };
  });
}
