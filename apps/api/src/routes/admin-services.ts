import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { gtfsManager } from "../services/gtfs/index";
import { jobRunner } from "../services/job-runner";
import { getServiceRegistry } from "../services/service-registry";
import { writeAuditLog } from "../utils/audit-log";
import { dockerComposeLogs, dockerComposePs } from "../utils/docker-compose";
import { serviceActionLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";

export async function adminServicesRoute(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return reply;
    request.adminSession = session;
  });

  // GET /admin/services — list all services from registry with docker ps status
  app.get("/admin/services", async () => {
    const registry = getServiceRegistry();
    const ps = await dockerComposePs();
    const services = registry.list().map((s) => ({
      id: s.manifest.id,
      name: s.manifest.name,
      version: s.manifest.version,
      description: s.manifest.description,
      quality: s.manifest.quality,
      provides: s.manifest.provides ?? [],
      consumes: s.manifest.consumes ?? [],
      exposure: s.manifest.exposure,
      enabled: s.enabled,
      isBuiltIn: s.isBuiltIn,
      status: ps.find((p) => p.service === s.manifest.id)?.state ?? "not-running",
    }));
    const running = services.filter((s) => s.status === "running").length;
    const stopped = services.filter((s) => s.status !== "running").length;
    return { services, summary: { running, stopped, total: services.length } };
  });

  // GET /admin/services/:id — single service detail
  app.get<{ Params: { id: string } }>("/admin/services/:id", async (req, reply) => {
    let svc: ReturnType<ReturnType<typeof getServiceRegistry>["get"]>;
    try {
      svc = getServiceRegistry().get(req.params.id);
    } catch {
      reply.status(503);
      return { error: "Service registry not available" };
    }
    if (!svc) {
      reply.status(404);
      return { error: "Service not found" };
    }
    const ps = await dockerComposePs();
    return {
      ...svc,
      status: ps.find((p) => p.service === svc?.manifest.id)?.state ?? "not-running",
    };
  });

  // POST /admin/services/:id/action — start | stop | restart
  app.post<{ Params: { id: string }; Body: { action: "start" | "stop" | "restart" } }>(
    "/admin/services/:id/action",
    { preHandler: [serviceActionLimit.preHandler()] },
    async (req, reply) => {
      const { id } = req.params;
      const { action } = req.body;
      if (!["start", "stop", "restart"].includes(action)) {
        reply.status(400);
        return { error: "Invalid action — must be start | stop | restart" };
      }
      const adminSession = getAdminSession(req);

      const jobId = await jobRunner.enqueue(
        `service.${action}`,
        { service: id },
        adminSession.user.id,
      );
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: id,
        targetType: "service",
        action: `service.${action}`,
        request: req,
      });
      return { ok: true, jobId };
    },
  );

  // GET /admin/services/:id/logs — stream logs as plain text
  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    "/admin/services/:id/logs",
    (req, reply) => {
      reply.header("Content-Type", "text/plain; charset=utf-8");
      reply.hijack();
      const tail = Math.min(Number(req.query.lines ?? 200), 1000);
      dockerComposeLogs(req.params.id, reply.raw, { tail });
    },
  );

  // GET /admin/deployment — deployment mode detection
  app.get("/admin/deployment", async () => {
    const { COMPOSE_FILE, MANAGE_SH, INFRA_DIR, isDockerAvailable } = await import(
      "../services/admin-ops"
    );
    const dockerAvailable = await isDockerAvailable();
    return {
      selfHosted: dockerAvailable,
      dockerAvailable,
      composeFileFound: existsSync(COMPOSE_FILE),
      manageSh: existsSync(MANAGE_SH),
      infraDir: INFRA_DIR,
    };
  });

  // POST /admin/services/check — docker compose ps summary
  app.post("/admin/services/check", async (request) => {
    const adminSession = getAdminSession(request);
    const ps = await dockerComposePs();
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "service",
      action: "service.health_check",
      request,
    });
    return { statuses: ps, checkedAt: new Date().toISOString() };
  });

  // GET /admin/services/data — data inventory (OSM, builds, GTFS)
  app.get("/admin/services/data", async () => {
    const { getOsmPbfInfo, getBuildStatuses } = await import("../services/admin-ops");
    const [osmInfo, buildStatuses, gtfsFeeds] = await Promise.all([
      getOsmPbfInfo(),
      getBuildStatuses(),
      Promise.resolve(gtfsManager.getFeeds()),
    ]);
    return { osm: osmInfo, builds: buildStatuses, gtfsFeeds, fetchedAt: new Date().toISOString() };
  });

  // POST /admin/services/data/build/:target — enqueue build job
  app.post<{ Params: { target: string } }>(
    "/admin/services/data/build/:target",
    async (request, reply) => {
      const { ALLOWED_BUILD_TARGETS } = await import("../services/admin-ops");
      const { target } = request.params;
      if (!ALLOWED_BUILD_TARGETS.has(target)) {
        return reply.status(400).send({ error: `Unknown build target: "${target}"` });
      }
      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue("build.target", { target }, adminSession.user.id);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: target,
        targetType: "build",
        action: "build.start",
        details: { target },
        request,
      });
      return { ok: true, jobId };
    },
  );

  // GET /admin/services/meta — static metadata for backward compat
  app.get("/admin/services/meta", async () => {
    const { PROFILE_SERVICES, ALLOWED_BUILD_TARGETS, SERVICE_META } = await import(
      "../services/admin-ops"
    );
    return {
      profiles: Object.keys(PROFILE_SERVICES),
      profileMap: PROFILE_SERVICES,
      buildTargets: Array.from(ALLOWED_BUILD_TARGETS),
      serviceMeta: SERVICE_META,
    };
  });
}
