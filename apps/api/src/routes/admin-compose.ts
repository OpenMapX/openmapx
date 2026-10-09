import { repoPaths, services } from "@openmapx/core/server";
import type { FastifyInstance } from "fastify";
import { applyHardlinksFromPlan, renderAndPersistCompose } from "../services/admin-ops";
import { readDesiredSelection } from "../services/desired-selection";
import {
  createDirectAdminOpsKey,
  DIRECT_OPS_IDEMPOTENCY_HEADER,
  parseDirectOpsIdempotency,
} from "../services/direct-ops-idempotency";
import { getServiceRegistry } from "../services/service-registry";
import { buildConfigurationInput, integrationSchemas } from "../services/trusted-config-operations";
import { dockerComposeAction, STACK_STOP_GUIDANCE } from "../utils/docker-compose";
import { requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";

export async function registerAdminComposeRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  app: FastifyInstance<any, any, any, any>,
): Promise<void> {
  declareRouteAuth(app, "admin");

  // GET /api/admin/compose/preview — render generated compose YAML from registry
  app.get("/api/admin/compose/preview", async (req, reply) => {
    await requireAdmin(req);
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
  app.post("/api/admin/compose/up", async (req, reply) => {
    const adminSession = await requireAdmin(req);
    let idempotencyValue: string;
    try {
      idempotencyValue = parseDirectOpsIdempotency(req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]);
    } catch (error) {
      reply.code(400);
      return { ok: false, error: (error as Error).message };
    }
    const operationKey = createDirectAdminOpsKey(adminSession.user.id, idempotencyValue);
    await renderAndPersistCompose({ operationKey });
    const hardlinks = await applyHardlinksFromPlan({ operationIdentity: operationKey });
    const r = await dockerComposeAction("", "start", {
      operationKey,
    });
    return { ok: r.exitCode === 0, stdout: r.stdout, hardlinks };
  });

  // POST /api/admin/compose/down — stop the whole stack
  app.post("/api/admin/compose/down", async (req, reply) => {
    await requireAdmin(req);
    reply.code(503);
    return { ok: false, error: STACK_STOP_GUIDANCE };
  });
}
