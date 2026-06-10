import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { serviceConfig } from "../db/schema";
import {
  assertValidBackupName,
  getServiceSelectionSummary,
  listBackupSummaries,
  writeServiceSelection as persistServiceSelection,
  validateServiceSelectionForWrite,
} from "../services/admin-cli";
import { gtfsManager } from "../services/gtfs/index";
import { jobRunner } from "../services/job-runner";
import { resolveServiceConfigWithSources } from "../services/service-config-resolver";
import { getServiceRegistry } from "../services/service-registry";
import { writeAuditLog } from "../utils/audit-log";
import { dockerComposeLogs, dockerComposePs } from "../utils/docker-compose";
import { serviceActionLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { validateConfigBody } from "../utils/validate-config-body";

const { getProvidedCapabilityNames, serviceConfigEnvPrefix } = coreServices;
const DATA_JOB_OPERATIONS = new Set([
  "download-osm",
  "download-gtfs",
  "download-style",
  "update",
  "convert-overpass",
  "link",
  "clean",
  "generate-api-keys",
] as const);
const BULK_SERVICE_ACTIONS = new Set(["start", "stop", "restart", "recreate", "build"] as const);

function toIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export async function adminServicesRoute(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
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
      // Verify the id is a known service before enqueueing — prevents the job
      // runner from spawning a `docker compose start <unknown>` call (or worse,
      // a flag-shaped id bleeding into the docker-compose argv).
      let registry: ReturnType<typeof getServiceRegistry>;
      try {
        registry = getServiceRegistry();
      } catch {
        reply.status(503);
        return { error: "Service registry not available" };
      }
      if (!registry.get(id)) {
        reply.status(404);
        return { error: `Service "${id}" not found` };
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

  // GET /admin/services/selection — requested + effective selection roots
  app.get("/admin/services/selection", async (_req, reply) => {
    let registry: ReturnType<typeof getServiceRegistry>;
    try {
      registry = getServiceRegistry();
    } catch {
      reply.status(503);
      return { error: "Service registry not available" };
    }
    return getServiceSelectionSummary(registry);
  });

  // PUT /admin/services/selection — persist selected root services
  app.put<{ Body: { selectedRoots?: string[] } }>(
    "/admin/services/selection",
    async (req, reply) => {
      let registry: ReturnType<typeof getServiceRegistry>;
      try {
        registry = getServiceRegistry();
      } catch {
        reply.status(503);
        return { error: "Service registry not available" };
      }

      const selectedRoots = toIdList(req.body?.selectedRoots);
      let validated: ReturnType<typeof validateServiceSelectionForWrite>;
      try {
        validated = validateServiceSelectionForWrite(registry, selectedRoots);
      } catch (err) {
        reply.status(400);
        return { error: (err as Error).message };
      }

      const path = persistServiceSelection(validated.normalized);
      const summary = getServiceSelectionSummary(registry);
      const adminSession = getAdminSession(req);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetType: "service",
        targetId: "selection",
        action: "service.selection.update",
        details: {
          selectedRoots: summary.selectedRoots,
          effectiveIds: summary.effectiveIds,
        },
        request: req,
      });

      return { ok: true, path, summary };
    },
  );

  // POST /admin/services/bulk-action — enqueue CLI-backed bulk service actions
  app.post<{
    Body: {
      action?: "start" | "stop" | "restart" | "recreate" | "build";
      serviceIds?: string[];
      all?: boolean;
      region?: string;
      continueOnError?: boolean;
    };
  }>("/admin/services/bulk-action", async (req, reply) => {
    const action = req.body?.action;
    if (!action || !BULK_SERVICE_ACTIONS.has(action)) {
      reply.status(400);
      return { error: "Invalid action (expected start|stop|restart|recreate|build)" };
    }

    const serviceIds = toIdList(req.body?.serviceIds);
    if (action !== "build" && serviceIds.length === 0) {
      reply.status(400);
      return { error: `Action "${action}" requires one or more serviceIds` };
    }
    if (action === "build" && req.body?.all !== true && serviceIds.length === 0) {
      reply.status(400);
      return { error: 'Build action requires serviceIds or explicit "all": true' };
    }

    const region =
      typeof req.body?.region === "string" && req.body.region.trim()
        ? req.body.region.trim()
        : undefined;
    const adminSession = getAdminSession(req);
    const jobId = await jobRunner.enqueue(
      "service.bulk",
      {
        action,
        serviceIds,
        all: req.body?.all === true,
        region,
        continueOnError: req.body?.continueOnError,
      },
      adminSession.user.id,
    );

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "service",
      targetId: serviceIds.join(",") || "all",
      action: `service.bulk.${action}`,
      details: { serviceIds, all: req.body?.all === true, region },
      request: req,
    });

    return { ok: true, jobId };
  });

  // GET /admin/services/:id/config — schema + per-field resolved values with
  // sources. Mirrors the shape returned by the integration config endpoint so
  // the admin UI can render source badges (default / database / env) and
  // disable editing for fields currently overridden by `SERVICE_<ID>_<KEY>`
  // env vars on the host.
  app.get<{ Params: { id: string } }>("/admin/services/:id/config", async (req, reply) => {
    const svc = getServiceRegistry().get(req.params.id);
    if (!svc) {
      reply.status(404);
      return { error: "Service not found" };
    }
    const resolvedConfig = await resolveServiceConfigWithSources({
      id: svc.manifest.id,
      configSchema: svc.manifest.configSchema,
    });
    return {
      schema: svc.manifest.configSchema ?? null,
      resolvedConfig,
      envPrefix: serviceConfigEnvPrefix(svc.manifest.id),
    };
  });

  // POST /admin/services/:id/config — merge per-service config updates (JSONB upsert)
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
      const [existing] = await db
        .select({ config: serviceConfig.config })
        .from(serviceConfig)
        .where(eq(serviceConfig.serviceId, req.params.id))
        .limit(1);
      const existingConfig = (existing?.config as Record<string, unknown>) ?? {};
      const newConfig = { ...existingConfig, ...config };

      await db
        .insert(serviceConfig)
        .values({ id: randomUUID(), serviceId: req.params.id, config: newConfig })
        .onConflictDoUpdate({
          target: serviceConfig.serviceId,
          set: { config: newConfig, updatedAt: new Date() },
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
    // When the API runs inside app-api, docker-compose actions need the
    // generated compose file's bind paths to resolve to real host paths.
    // That only works when the operator sets OPENMAPX_HOST_DIR to the
    // absolute host-side repo path and the app-api service.json bind-mounts
    // `${OPENMAPX_HOST_DIR}:${OPENMAPX_HOST_DIR}`. Surface the state so the
    // admin UI can warn on deploy actions that would silently no-op.
    const hostDir = process.env.OPENMAPX_HOST_DIR?.trim();
    const hostControlConfigured = Boolean(hostDir) && existsSync(hostDir as string);
    return {
      selfHosted: dockerAvailable,
      dockerAvailable,
      hostControlConfigured,
      hostDir: hostDir ?? null,
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
    const { getOsmPbfInfo, getBuildStatuses, getMotisTransitousStatus, getMotisGtfsArchives } =
      await import("../services/admin-ops");
    const [osmInfo, buildStatuses, gtfsFeeds, motisTransitous, motisGtfsArchives] =
      await Promise.all([
        getOsmPbfInfo(),
        getBuildStatuses(),
        Promise.resolve(gtfsManager.getFeeds()),
        Promise.resolve(getMotisTransitousStatus()),
        getMotisGtfsArchives(),
      ]);
    return {
      osm: osmInfo,
      builds: buildStatuses,
      gtfsFeeds,
      motisGtfsArchives,
      motisTransitous,
      fetchedAt: new Date().toISOString(),
    };
  });

  // POST /admin/services/data/action — enqueue CLI-backed data operations
  app.post<{
    Body: {
      operation?:
        | "download-osm"
        | "download-gtfs"
        | "download-style"
        | "update"
        | "convert-overpass"
        | "link"
        | "clean"
        | "generate-api-keys";
      region?: string;
      countries?: string;
      feedsFile?: string;
      failFast?: boolean;
      target?: string;
      repoUrl?: string;
      output?: string;
    };
  }>("/admin/services/data/action", async (req, reply) => {
    const operation = req.body?.operation;
    if (!operation || !DATA_JOB_OPERATIONS.has(operation)) {
      reply.status(400);
      return { error: "Invalid operation" };
    }
    if (operation === "clean" && (!req.body.target || req.body.target.trim() === "")) {
      reply.status(400);
      return { error: "clean operation requires target" };
    }

    const adminSession = getAdminSession(req);
    const jobId = await jobRunner.enqueue(
      "data.operation",
      {
        operation,
        region: req.body?.region,
        countries: req.body?.countries,
        feedsFile: req.body?.feedsFile,
        failFast: req.body?.failFast === true,
        target: req.body?.target,
        repoUrl: req.body?.repoUrl,
        output: req.body?.output,
      },
      adminSession.user.id,
    );
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "data",
      targetId: operation,
      action: `data.${operation}`,
      request: req,
    });
    return { ok: true, jobId };
  });

  // GET /admin/services/backups — list on-disk backup manifests
  app.get("/admin/services/backups", async () => {
    const { backups, warnings, root } = listBackupSummaries();
    return { backups, warnings, root };
  });

  // POST /admin/services/backups — create backup job
  app.post<{ Body: { name?: string } }>("/admin/services/backups", async (req, reply) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (name) {
      try {
        assertValidBackupName(name);
      } catch (err) {
        reply.status(400);
        return { error: (err as Error).message };
      }
    }

    const adminSession = getAdminSession(req);
    const jobId = await jobRunner.enqueue(
      "backup.operation",
      { operation: "create", name: name || undefined },
      adminSession.user.id,
    );
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "backup",
      targetId: name || "auto",
      action: "backup.create",
      details: { name: name || null, jobId },
      request: req,
    });
    return { ok: true, jobId };
  });

  // POST /admin/services/backups/:name/restore — restore backup job
  app.post<{
    Params: { name: string };
    Body: { serviceIds?: string[]; stopRunning?: boolean };
  }>("/admin/services/backups/:name/restore", async (req, reply) => {
    const name = req.params.name.trim();
    try {
      assertValidBackupName(name);
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }

    const { backups } = listBackupSummaries();
    const target = backups.find((backup) => backup.name === name);
    if (!target) {
      reply.status(404);
      return { error: `Backup not found: ${name}` };
    }
    if (target.corrupt) {
      reply.status(409);
      return {
        error: `Backup '${name}' is corrupt and cannot be restored: ${target.corruptReason ?? "unknown reason"}`,
      };
    }

    const serviceIds = toIdList(req.body?.serviceIds);
    const adminSession = getAdminSession(req);
    const jobId = await jobRunner.enqueue(
      "backup.operation",
      {
        operation: "restore",
        name,
        serviceIds,
        stopRunning: req.body?.stopRunning === true,
      },
      adminSession.user.id,
    );
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "backup",
      targetId: name,
      action: "backup.restore",
      details: { serviceIds, stopRunning: req.body?.stopRunning === true, jobId },
      request: req,
    });
    return { ok: true, jobId };
  });

  // DELETE /admin/services/backups/:name — delete backup job
  app.delete<{ Params: { name: string } }>("/admin/services/backups/:name", async (req, reply) => {
    const name = req.params.name.trim();
    try {
      assertValidBackupName(name);
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }

    const { backups } = listBackupSummaries();
    if (!backups.some((backup) => backup.name === name)) {
      reply.status(404);
      return { error: `Backup not found: ${name}` };
    }

    const adminSession = getAdminSession(req);
    const jobId = await jobRunner.enqueue(
      "backup.operation",
      { operation: "delete", name },
      adminSession.user.id,
    );
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "backup",
      targetId: name,
      action: "backup.delete",
      details: { jobId },
      request: req,
    });
    return { ok: true, jobId };
  });
}
