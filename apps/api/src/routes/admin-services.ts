import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  ALLOWED_BUILD_TARGETS,
  ALLOWED_PROFILES,
  ALLOWED_SERVICES,
  COMPOSE_FILE,
  getBuildStatuses,
  getOsmPbfInfo,
  getServiceLogs,
  getServiceStatuses,
  INFRA_DIR,
  isDockerAvailable,
  MANAGE_SH,
  PROFILE_SERVICES,
  SERVICE_META,
} from "../services/admin-ops";
import { gtfsManager } from "../services/gtfs/index";
import { jobRunner } from "../services/job-runner";
import { writeAuditLog } from "../utils/audit-log";
import { serviceActionLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";

export async function adminServicesRoute(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return reply;
    request.adminSession = session;
  });

  // GET /admin/deployment — deployment mode detection
  app.get("/admin/deployment", async () => {
    const dockerAvailable = await isDockerAvailable();
    return {
      selfHosted: dockerAvailable,
      dockerAvailable,
      composeFileFound: existsSync(COMPOSE_FILE),
      manageSh: existsSync(MANAGE_SH),
      infraDir: INFRA_DIR,
    };
  });

  // GET /admin/services — all services with current status
  app.get("/admin/services", async () => {
    const statuses = await getServiceStatuses();
    const running = statuses.filter((s) => s.state === "running").length;
    const stopped = statuses.filter((s) => s.state === "stopped").length;
    const unhealthy = statuses.filter((s) => s.state === "unhealthy").length;
    return { services: statuses, summary: { running, stopped, unhealthy, total: statuses.length } };
  });

  // GET /admin/services/profiles — profiles with their services
  app.get("/admin/services/profiles", async () => {
    const statuses = await getServiceStatuses();
    const statusMap = new Map(statuses.map((s) => [s.service, s]));

    const profiles = Object.entries(PROFILE_SERVICES).map(([profile, services]) => {
      const svcStatuses = services.map((s) => statusMap.get(s) ?? { service: s, state: "unknown" });
      const allRunning = svcStatuses.every((s) => s.state === "running");
      const anyRunning = svcStatuses.some((s) => s.state === "running");
      return {
        profile,
        services,
        controllable: ALLOWED_PROFILES.has(profile),
        state: allRunning ? "running" : anyRunning ? "partial" : "stopped",
        serviceStatuses: svcStatuses,
      };
    });

    return { profiles };
  });

  // GET /admin/services/:service/logs
  app.get<{ Params: { service: string }; Querystring: { lines?: string } }>(
    "/admin/services/:service/logs",
    async (request, reply) => {
      const { service } = request.params;
      if (!ALLOWED_SERVICES.has(service)) {
        return reply.status(400).send({ error: `Unknown service: "${service}"` });
      }
      const lines = Math.min(Number(request.query.lines ?? 100), 1000);
      try {
        const text = await getServiceLogs(service, lines);
        reply.header("Content-Type", "text/plain; charset=utf-8");
        return reply.send(text);
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // POST /admin/services/:service/start
  app.post<{ Params: { service: string } }>(
    "/admin/services/:service/start",
    { preHandler: [serviceActionLimit.preHandler()] },
    async (request, reply) => {
      const { service } = request.params;
      if (!ALLOWED_SERVICES.has(service)) {
        return reply.status(400).send({ error: `Unknown service: "${service}"` });
      }
      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue("service.start", { service }, adminSession.user.id);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: service,
        targetType: "service",
        action: "service.start",
        request,
      });
      return { ok: true, jobId };
    },
  );

  // POST /admin/services/:service/stop
  app.post<{ Params: { service: string } }>(
    "/admin/services/:service/stop",
    { preHandler: [serviceActionLimit.preHandler()] },
    async (request, reply) => {
      const { service } = request.params;
      if (!ALLOWED_SERVICES.has(service)) {
        return reply.status(400).send({ error: `Unknown service: "${service}"` });
      }
      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue("service.stop", { service }, adminSession.user.id);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: service,
        targetType: "service",
        action: "service.stop",
        request,
      });
      return { ok: true, jobId };
    },
  );

  // POST /admin/services/:service/restart
  app.post<{ Params: { service: string } }>(
    "/admin/services/:service/restart",
    { preHandler: [serviceActionLimit.preHandler()] },
    async (request, reply) => {
      const { service } = request.params;
      if (!ALLOWED_SERVICES.has(service)) {
        return reply.status(400).send({ error: `Unknown service: "${service}"` });
      }
      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue("service.restart", { service }, adminSession.user.id);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: service,
        targetType: "service",
        action: "service.restart",
        request,
      });
      return { ok: true, jobId };
    },
  );

  // POST /admin/services/profiles/:profile/start
  app.post<{ Params: { profile: string } }>(
    "/admin/services/profiles/:profile/start",
    { preHandler: [serviceActionLimit.preHandler()] },
    async (request, reply) => {
      const { profile } = request.params;
      if (!ALLOWED_PROFILES.has(profile)) {
        return reply.status(400).send({ error: `Unknown profile: "${profile}"` });
      }
      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue("profile.start", { profile }, adminSession.user.id);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: profile,
        targetType: "service_profile",
        action: "profile.start",
        request,
      });
      return { ok: true, jobId };
    },
  );

  // POST /admin/services/profiles/:profile/stop
  app.post<{ Params: { profile: string } }>(
    "/admin/services/profiles/:profile/stop",
    { preHandler: [serviceActionLimit.preHandler()] },
    async (request, reply) => {
      const { profile } = request.params;
      if (!ALLOWED_PROFILES.has(profile)) {
        return reply.status(400).send({ error: `Unknown profile: "${profile}"` });
      }
      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue("profile.stop", { profile }, adminSession.user.id);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: profile,
        targetType: "service_profile",
        action: "profile.stop",
        request,
      });
      return { ok: true, jobId };
    },
  );

  // POST /admin/services/check — run docker compose ps and return summary
  app.post("/admin/services/check", async (request, _reply) => {
    const adminSession = getAdminSession(request);

    const statuses = await getServiceStatuses();
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "service",
      action: "service.health_check",
      request,
    });
    return { statuses, checkedAt: new Date().toISOString() };
  });

  // GET /admin/services/data — data inventory
  app.get("/admin/services/data", async () => {
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

  // GET /admin/services/meta — static metadata (profiles, allowed services)
  app.get("/admin/services/meta", async () => {
    return {
      profiles: Object.keys(PROFILE_SERVICES),
      profileMap: PROFILE_SERVICES,
      buildTargets: Array.from(ALLOWED_BUILD_TARGETS),
      serviceMeta: SERVICE_META,
    };
  });
}
