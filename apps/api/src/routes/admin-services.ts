import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { serviceConfig } from "../db/schema";
import { gtfsManager } from "../services/gtfs/index";
import { jobRunner } from "../services/job-runner";
import { getServiceRegistry } from "../services/service-registry";
import { writeAuditLog } from "../utils/audit-log";
import { dockerComposeLogs, dockerComposePs } from "../utils/docker-compose";
import { serviceActionLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { validateConfigBody } from "../utils/validate-config-body";

const { getProvidedCapabilityNames } = coreServices;

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
      // Normalised to bare strings for the admin UI; the structured-form
      // metadata isn't surfaced anywhere yet (reserved slot for future
      // runtime layers like region-aware routing).
      provides: getProvidedCapabilityNames(s.manifest.provides),
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

  // GET /admin/services/:id/config — current per-service operator config (JSON-Schema-shaped)
  app.get<{ Params: { id: string } }>("/admin/services/:id/config", async (req, reply) => {
    const svc = getServiceRegistry().get(req.params.id);
    if (!svc) {
      reply.status(404);
      return { error: "Service not found" };
    }
    const [row] = await db
      .select({ config: serviceConfig.config })
      .from(serviceConfig)
      .where(eq(serviceConfig.serviceId, req.params.id))
      .limit(1);
    return {
      schema: svc.manifest.configSchema ?? null,
      config: row?.config ?? {},
    };
  });

  // POST /admin/services/:id/config — replace per-service config (JSONB upsert)
  app.post<{ Params: { id: string }; Body: { config: Record<string, unknown> } }>(
    "/admin/services/:id/config",
    async (req, reply) => {
      const svc = getServiceRegistry().get(req.params.id);
      if (!svc) {
        reply.status(404);
        return { error: "Service not found" };
      }
      const body = req.body?.config;
      // Validate against the manifest's configSchema so operators can't store
      // values the service won't accept at startup. Same validator used by the
      // integration config endpoint.
      const { updates: config, errors } = validateConfigBody(body, svc.manifest.configSchema, {
        // Service manifests don't model "enabled" today; nothing to reject.
        rejectEnabled: false,
        // Service configs don't yet declare secret fields, but reject them
        // anyway so future secret declarations don't accidentally land here.
        rejectSecrets: true,
      });
      if (errors.length > 0) {
        reply.status(400);
        return { errors };
      }
      const adminSession = getAdminSession(req);
      await db
        .insert(serviceConfig)
        .values({ id: randomUUID(), serviceId: req.params.id, config })
        .onConflictDoUpdate({
          target: serviceConfig.serviceId,
          set: { config, updatedAt: new Date() },
        });
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: req.params.id,
        targetType: "service",
        action: "service.config.update",
        details: { keys: Object.keys(config) },
        request: req,
      });
      return { ok: true };
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
    const { INFRA_DIR, isDockerAvailable } = await import("../services/admin-ops");
    const dockerAvailable = await isDockerAvailable();
    const composePath = join(INFRA_DIR, "docker-compose.generated.yml");
    return {
      selfHosted: dockerAvailable,
      dockerAvailable,
      // True once the operator has run `pnpm openmapx compose render`.
      composeRendered: existsSync(composePath),
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
}
