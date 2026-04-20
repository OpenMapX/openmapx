import { dirname, resolve } from "node:path";
import { services } from "@openmapx/core/server";
import type { FastifyInstance } from "fastify";
import { resolveAllServiceConfigs } from "../services/service-config-resolver";
import { getServiceRegistry } from "../services/service-registry";
import { dockerComposeAction } from "../utils/docker-compose";
import { requireAdmin } from "../utils/require-admin";

const { buildAppApiServiceEnv, renderCompose } = services;

// `composeOutDir` makes the renderer emit bind-mount sources as paths relative
// to the (eventual) compose file location, matching what `pnpm openmapx compose
// render` writes to disk. The file isn't actually written here; this only keeps
// the previewed YAML byte-identical to what an operator would see after running
// the CLI render.
const COMPOSE_OUT_DIR = resolve(dirname(process.cwd()), "..", "infra", "docker");

export async function registerAdminComposeRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  app: FastifyInstance<any, any, any, any>,
): Promise<void> {
  // GET /api/admin/compose/preview — render generated compose YAML from registry
  app.get("/api/admin/compose/preview", async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    let registry: ReturnType<typeof getServiceRegistry>;
    try {
      registry = getServiceRegistry();
    } catch {
      reply.status(503);
      return { error: "Service registry not available" };
    }
    const domain = process.env.DOMAIN ?? "localhost";
    const enabled = registry.enabled();
    // Resolve the full config cascade (defaults + DB + env) for every enabled
    // service before rendering, so `SERVICE_<ID>_<KEY>=...` on the host and
    // admin-panel-saved values both land in the generated compose env.
    const resolvedServiceConfigs = await resolveAllServiceConfigs(
      enabled.map((s) => ({ id: s.manifest.id, configSchema: s.manifest.configSchema })),
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
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const r = await dockerComposeAction("", "start");
    return { ok: r.exitCode === 0, stdout: r.stdout };
  });

  // POST /api/admin/compose/down — stop the whole stack
  app.post("/api/admin/compose/down", async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const r = await dockerComposeAction("", "stop");
    return { ok: r.exitCode === 0, stdout: r.stdout };
  });
}
