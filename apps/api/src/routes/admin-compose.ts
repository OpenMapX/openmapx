import { repoPaths, services } from "@openmapx/core/server";
import type { FastifyInstance } from "fastify";
import { applyHardlinksFromPlan, renderAndPersistCompose } from "../services/admin-ops";
import {
  createDirectAdminOpsKey,
  DIRECT_OPS_IDEMPOTENCY_HEADER,
  parseDirectOpsIdempotency,
} from "../services/direct-ops-idempotency";
import { resolveAllServiceConfigs } from "../services/service-config-resolver";
import { getServiceRegistry } from "../services/service-registry";
import { dockerComposeAction, STACK_STOP_GUIDANCE } from "../utils/docker-compose";
import { envString } from "../utils/env";
import { requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";

const { buildAppApiServiceEnv, renderCompose } = services;

// `composeOutDir` makes the renderer emit bind-mount sources as paths relative
// to the (eventual) compose file location, matching what `pnpm openmapx compose
// render` writes to disk. The file isn't actually written here; this only keeps
// the previewed YAML byte-identical to what an operator would see after running
// the CLI render.
const COMPOSE_OUT_DIR = repoPaths().infraDir;

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
    const domain = envString("DOMAIN", "localhost");
    const enabled = registry.enabled();
    // Resolve the full config cascade (defaults + DB + env) for every enabled
    // service before rendering, so `SERVICE_<ID>_<KEY>=...` on the host and
    // admin-panel-saved values both land in the generated compose env.
    const resolvedServiceConfigs = await resolveAllServiceConfigs(
      enabled.map((s) => ({
        id: s.manifest.id,
        configSchema: s.manifest.configSchema,
        containerEnv: s.manifest.container.environment,
      })),
    );
    if (enabled.some((s) => s.manifest.id === "app-api")) {
      resolvedServiceConfigs.set(
        "app-api",
        buildAppApiServiceEnv(enabled, resolvedServiceConfigs.get("app-api") ?? {}, process.env),
      );
    }
    const result = renderCompose(enabled, {
      domain,
      composeOutDir: COMPOSE_OUT_DIR,
      allServices: registry.list(),
      resolvedServiceConfigs,
    });
    reply.header("Content-Type", "text/yaml; charset=utf-8");
    return result.composeYaml;
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
