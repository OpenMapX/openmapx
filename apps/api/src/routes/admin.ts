import { randomUUID } from "node:crypto";
import { type CredentialSetup, integrationEnvVarName } from "@openmapx/integration-framework";
import { and, count, desc, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { adminAuditLog, integrationConfig, session, user } from "../db/schema";
import {
  getAllIntegrations,
  getIntegration,
  reloadIntegrations,
  resolveConfigWithSources,
} from "../integration-host";
import {
  type ActivityJobFilter,
  type ActivityJobSource,
  getActivityJob,
  listActivityJobs,
} from "../services/activity-jobs";
import { isDockerAvailable } from "../services/admin-ops";
import { getTimeline } from "../services/health-history";
import {
  executeAllIntegrationHealthChecks,
  executeIntegrationHealthCheck,
  getCachedHealthStatus,
} from "../services/integration-health";
import { jobRunner } from "../services/job-runner";
import {
  deleteSecret,
  isSecretsConfigured,
  listAllSecrets,
  listSecrets,
  setSecret,
} from "../services/secrets";
import { writeAuditLog } from "../utils/audit-log";
import { dockerComposePs, type PsEntry } from "../utils/docker-compose";
import { maskSecretConfigRecord, maskSecretConfigValues } from "../utils/mask-config.js";
import { healthCheckSweepLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { resolveActors } from "../utils/resolve-actor";
import { declareRouteAuth } from "../utils/route-auth.js";
import { getSecretFields, validateConfigBody } from "../utils/validate-config-body";

function getIntegrationDisplayName(integration: {
  id: string;
  manifest: { name?: string };
  strings: Record<string, Record<string, unknown>>;
}): string {
  const en = integration.strings.en as Record<string, unknown> | undefined;
  return (en?.name as string) ?? integration.manifest.name ?? integration.id;
}

// `getSecretFields` lives next to `validateConfigBody` so the two stay in
// sync (both walk the same configSchema.properties shape).

interface CredentialStatusEntry {
  key: string;
  title: string;
  description?: string;
  source: "vault" | "env" | "missing";
  sharedSecretName?: string;
  setup?: CredentialSetup;
  updatedAt?: string;
  updatedBy?: string | null;
}

/**
 * Compute credential status for an integration — one entry per
 * `x-openmapx-secret: true` field in the configSchema. Secrets are sourced
 * from the encrypted vault (admin-panel path) or a host env var matching
 * `INTEGRATION_<ID>_<KEY>` (env override).
 */
async function computeCredentialStatus(integration: {
  id: string;
  manifest: { configSchema?: Record<string, unknown> };
}): Promise<CredentialStatusEntry[]> {
  const secretFields = getSecretFields(integration.manifest.configSchema);
  if (secretFields.length === 0) return [];
  const vaultList = await listSecrets(integration.id);
  const vaultMap = new Map(vaultList.map((v) => [v.key, v]));

  const result: CredentialStatusEntry[] = [];
  for (const field of secretFields) {
    const vaultEntry = vaultMap.get(field.key);
    const envKey = integrationEnvVarName(integration.id, field.key);
    const hasEnv = !!(process.env[envKey] && process.env[envKey] !== "");

    let source: "vault" | "env" | "missing" = "missing";
    if (vaultEntry) source = "vault";
    else if (hasEnv) source = "env";

    result.push({
      key: field.key,
      title: field.title,
      description: field.description,
      source,
      sharedSecretName: field.sharedSecretName,
      setup: field.setup,
      updatedAt: vaultEntry?.updatedAt?.toISOString(),
      updatedBy: vaultEntry?.updatedBy ?? null,
    });
  }
  return result;
}

interface AuditFilters {
  action?: string;
  targetType?: string;
  targetId?: string;
  actorId?: string;
}

/**
 * Build the drizzle `where` clause shared by the audit-log list endpoint and
 * the audit-log export endpoint, so the two can never drift in how they
 * interpret the `action`/`targetType`/`targetId`/`actorId` filters.
 */
function buildAuditQuery(filters: AuditFilters) {
  const conditions = [];
  if (filters.action) conditions.push(eq(adminAuditLog.action, filters.action));
  if (filters.targetType) conditions.push(eq(adminAuditLog.targetType, filters.targetType));
  if (filters.targetId) conditions.push(eq(adminAuditLog.targetId, filters.targetId));
  if (filters.actorId) conditions.push(eq(adminAuditLog.actorId, filters.actorId));
  return conditions.length ? and(...conditions) : undefined;
}

// Largest synchronous audit-log export. A genuinely unbounded export needs a
// streaming/job design; for now we cap at the most-recent rows and flag
// truncation via the `X-Export-Truncated` response header.
const AUDIT_EXPORT_MAX_ROWS = 10_000;

const AUDIT_CSV_COLUMNS = ["createdAt", "actorId", "action", "targetType", "targetId"] as const;

/** Quote a CSV field per RFC 4180 when it contains a comma, quote, or newline. */
function csvField(value: unknown): string {
  if (value == null) return "";
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function adminRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  app.get("/admin/overview", async () => {
    const selfHosted = await isDockerAvailable();
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      [userRow],
      [bannedRow],
      [activeSessionRow],
      integrations,
      recentAudit,
      activityJobs,
      dockerServices,
    ] = await Promise.all([
      db.select({ total: count() }).from(user),
      db.select({ total: count() }).from(user).where(eq(user.banned, true)),
      db.select({ total: count() }).from(session).where(gt(session.updatedAt, twentyFourHoursAgo)),
      Promise.resolve(getAllIntegrations()),
      db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(10),
      listActivityJobs({ limit: 10, offset: 0 }),
      selfHosted ? dockerComposePs() : Promise.resolve([] as PsEntry[]),
    ]);

    const totalUsers = userRow?.total ?? 0;
    const bannedUsers = bannedRow?.total ?? 0;
    const activeSessions24h = activeSessionRow?.total ?? 0;

    const totalIntegrations = integrations.length;
    const enabledIntegrations = integrations.filter((i) => i.enabled).length;
    const credentialStatuses = await Promise.all(
      integrations.filter((i) => i.enabled).map((i) => computeCredentialStatus(i)),
    );
    const unconfiguredIntegrations = credentialStatuses.filter(
      (statuses) => statuses.length > 0 && statuses.every((s) => s.source === "missing"),
    ).length;
    const unhealthyIntegrations = integrations.filter((i) => {
      if (!i.enabled || !i.manifest.healthCheck) return false;
      const cached = getCachedHealthStatus(i.id);
      return cached?.status === "down";
    }).length;

    // Services summary (Docker only). The new `dockerComposePs` helper reports
    // raw docker states; we collapse "exited"/"created"/"paused"/"not-running"
    // into a single "stopped" bucket and treat "restarting" as "unhealthy".
    const runningServices = dockerServices.filter((s) => s.state === "running").length;
    const stoppedServices = dockerServices.filter(
      (s) => s.state !== "running" && s.state !== "restarting",
    ).length;
    const unhealthyServices = dockerServices.filter((s) => s.state === "restarting").length;

    // System health
    const unhealthyCount = unhealthyIntegrations + unhealthyServices;
    let overallHealth: "pass" | "degraded" | "down" = "pass";
    if (unhealthyCount > 0) overallHealth = "degraded";
    if (
      (enabledIntegrations > 0 && unhealthyIntegrations > enabledIntegrations / 2) ||
      (selfHosted && runningServices > 0 && unhealthyServices > runningServices)
    ) {
      overallHealth = "down";
    }

    // Attention items
    const attention: Array<{
      type: string;
      severity: "warning" | "error" | "info";
      message: string;
      target?: string;
    }> = [];

    // Missing credentials — flag integrations where every declared secret is
    // unresolved (no vault value, no env var override).
    const enabledIntegrationList = integrations.filter((i) => i.enabled);
    for (let idx = 0; idx < enabledIntegrationList.length; idx++) {
      const i = enabledIntegrationList[idx];
      if (!i) continue;
      const statuses = credentialStatuses[idx] ?? [];
      if (statuses.length === 0) continue;
      if (statuses.every((s) => s.source === "missing")) {
        attention.push({
          type: "missing_credentials",
          severity: "warning",
          message: `${getIntegrationDisplayName(i)} has missing credentials`,
          target: i.id,
        });
      }
    }

    // Failing health checks
    for (const i of integrations) {
      if (!i.enabled || !i.manifest.healthCheck) continue;
      const cached = getCachedHealthStatus(i.id);
      if (cached?.status === "down") {
        attention.push({
          type: "health_check_failed",
          severity: "error",
          message: `${getIntegrationDisplayName(i)} health check failing: ${cached.error ?? "unknown"}`,
          target: i.id,
        });
      }
    }

    // Failed jobs among the most recent cross-system activity.
    for (const job of activityJobs.jobs) {
      if (job.status === "failed" || job.status === "interrupted") {
        attention.push({
          type: "job_failed",
          severity: "error",
          message: job.error
            ? `Job "${job.type}" failed: ${job.error}`
            : `Job "${job.type}" ${job.status === "interrupted" ? "was interrupted" : "failed"}`,
          target: job.id,
        });
      }
    }

    // Unhealthy Docker services — `restarting` is the closest signal to the
    // legacy "unhealthy" state that `docker compose ps --format json` exposes
    // without per-service healthcheck inspection.
    for (const svc of dockerServices) {
      if (svc.state === "restarting") {
        attention.push({
          type: "service_unhealthy",
          severity: "error",
          message: `Docker service "${svc.service}" is unhealthy`,
          target: svc.service,
        });
      }
    }

    return {
      systemHealth: {
        status: overallHealth,
        unhealthyCount,
      },
      users: {
        total: totalUsers,
        active24h: activeSessions24h,
        banned: bannedUsers,
      },
      integrations: {
        total: totalIntegrations,
        enabled: enabledIntegrations,
        unhealthy: unhealthyIntegrations,
        unconfigured: unconfiguredIntegrations,
      },
      services: selfHosted
        ? {
            running: runningServices,
            stopped: stoppedServices,
            unhealthy: unhealthyServices,
          }
        : null,
      attention,
      recentActivity: recentAudit,
      activeJobs: activityJobs.jobs,
    };
  });

  app.get("/admin/integrations", async () => {
    const all = getAllIntegrations();
    return Promise.all(
      all.map(async (integration) => {
        const cached = getCachedHealthStatus(integration.id);
        const statuses = await computeCredentialStatus(integration);
        // `configured` is true when every declared secret has a vault or env
        // value (or when the integration declares no secrets at all).
        const configured = statuses.every((s) => s.source !== "missing");
        return {
          id: integration.id,
          name: getIntegrationDisplayName(integration),
          description: integration.manifest.description,
          version: integration.manifest.version,
          domains: integration.manifest.domains,
          quality: integration.manifest.quality ?? "built-in",
          isBuiltIn: integration.isBuiltIn,
          enabled: integration.enabled,
          configured,
          hasHealthCheck: !!integration.manifest.healthCheck,
          health: cached
            ? { status: cached.status, responseTime: cached.responseTime, error: cached.error }
            : null,
          dependencies: integration.manifest.dependencies ?? [],
          requires: integration.manifest.requires ?? [],
          infrastructure: integration.manifest.infrastructure ?? null,
        };
      }),
    );
  });

  // GET /admin/integrations/env-vars — bulk env-var catalogue used by the
  // /admin/integrations/bulk page so the operator can copy a complete list
  // of host overrides into infra/docker/.env without opening each
  // integration. Returned values are never the secret bodies — only field
  // names, present/missing flags, and non-secret defaults.
  app.get("/admin/integrations/env-vars", async () => {
    const all = getAllIntegrations();
    const integrations = all
      .map((integration) => {
        const props = (integration.manifest.configSchema?.properties ?? {}) as Record<
          string,
          {
            title?: string;
            description?: string;
            default?: unknown;
            "x-openmapx-secret"?: boolean;
          }
        >;
        const envVars = Object.entries(props)
          .filter(([key]) => key !== "type" && key !== "properties" && key !== "enabled")
          .map(([key, def]) => {
            const name = integrationEnvVarName(integration.id, key);
            const secret = def?.["x-openmapx-secret"] === true;
            return {
              key,
              name,
              title: def?.title ?? key,
              description: def?.description,
              secret,
              present: !!process.env[name],
              defaultValue: secret ? undefined : (def?.default ?? undefined),
            };
          });
        return {
          id: integration.id,
          name: getIntegrationDisplayName(integration),
          enabled: integration.enabled,
          envVars,
        };
      })
      .filter((entry) => entry.envVars.length > 0);
    return { integrations };
  });

  app.get<{ Params: { id: string } }>("/admin/integrations/:id", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const [cached, resolvedRaw, credentialStatus] = await Promise.all([
      Promise.resolve(getCachedHealthStatus(integration.id)),
      resolveConfigWithSources(integration.manifest, integration.directory),
      computeCredentialStatus(integration),
    ]);

    const resolvedConfig = maskSecretConfigValues(resolvedRaw, integration.manifest.configSchema);

    const dependencyStatus = (integration.manifest.dependencies ?? []).map((depId) => {
      const dep = getIntegration(depId);
      return { id: depId, loaded: !!dep, enabled: dep?.enabled ?? false };
    });

    // Every declared secret has a vault or env value (or the integration
    // declares none).
    const configured = credentialStatus.every((s) => s.source !== "missing");

    return {
      id: integration.id,
      name: getIntegrationDisplayName(integration),
      description: integration.manifest.description,
      version: integration.manifest.version,
      author: integration.manifest.author,
      license: integration.manifest.license,
      documentation: integration.manifest.documentation,
      domains: integration.manifest.domains,
      quality: integration.manifest.quality ?? "built-in",
      isBuiltIn: integration.isBuiltIn,
      enabled: integration.enabled,
      configured,
      hasHealthCheck: !!integration.manifest.healthCheck,
      health: cached
        ? { status: cached.status, responseTime: cached.responseTime, error: cached.error }
        : null,
      dependencies: integration.manifest.dependencies ?? [],
      requires: integration.manifest.requires ?? [],
      infrastructure: integration.manifest.infrastructure ?? null,
      manifest: integration.manifest,
      resolvedConfig,
      dependencyStatus,
      credentialStatus,
      secretsConfigured: isSecretsConfigured(),
    };
  });

  app.get<{ Params: { id: string } }>("/admin/integrations/:id/health", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    if (!integration.manifest.healthCheck) {
      return { id: integration.id, status: "unconfigured", error: "No health check defined" };
    }

    const results = await executeIntegrationHealthCheck(integration);
    return results.length > 0
      ? results
      : [{ id: integration.id, status: "unconfigured", error: "No health check defined" }];
  });

  app.post(
    "/admin/integrations/health/run",
    { preHandler: [healthCheckSweepLimit.preHandler()] },
    async () => {
      const all = getAllIntegrations().filter((i) => i.enabled);
      const results = await executeAllIntegrationHealthChecks(all);
      return { timestamp: new Date().toISOString(), count: results.length, results };
    },
  );

  app.post("/admin/integrations/reload", async (request, _reply) => {
    const adminSession = getAdminSession(request);

    const jobId = await jobRunner.enqueue("integration.reload", {}, adminSession.user.id);

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "integration",
      action: "integration.reload.all",
      request,
    });

    return { ok: true, jobId };
  });

  // PATCH /admin/integrations/:id/config — update non-secret config fields
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/admin/integrations/:id/config",
    async (request, reply) => {
      const integration = getIntegration(request.params.id);
      if (!integration) return reply.status(404).send({ error: "Integration not found" });

      const adminSession = getAdminSession(request);

      // Same JSON-Schema-shaped validator the service config endpoint uses;
      // rejects unknown keys, secret fields (must go through the credentials
      // API), the `enabled` switch (use enable/disable endpoints), and
      // mismatched primitive types.
      const { updates, errors } = validateConfigBody(
        request.body,
        integration.manifest.configSchema as Record<string, unknown> | undefined,
      );
      if (errors.length > 0) {
        return reply.status(400).send({ errors });
      }
      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: "No valid fields to update" });
      }

      // Merge with existing DB config
      const [existing] = await db
        .select({ config: integrationConfig.config })
        .from(integrationConfig)
        .where(eq(integrationConfig.integrationId, integration.id))
        .limit(1);

      const existingConfig = (existing?.config as Record<string, unknown>) ?? {};
      const newConfig = { ...existingConfig, ...updates };

      await db
        .insert(integrationConfig)
        .values({ id: randomUUID(), integrationId: integration.id, config: newConfig })
        .onConflictDoUpdate({
          target: integrationConfig.integrationId,
          set: { config: newConfig, updatedAt: new Date() },
        });

      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: integration.id,
        targetType: "integration",
        action: "integration.config.update",
        details: { keys: Object.keys(updates) },
        request,
      });

      // Reload to apply new config
      const reloadResult = await reloadIntegrations();
      return { ok: true, updated: Object.keys(updates), ...reloadResult };
    },
  );

  // POST /admin/integrations/:id/enable
  app.post<{ Params: { id: string } }>("/admin/integrations/:id/enable", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const adminSession = getAdminSession(request);

    const [existing] = await db
      .select({ config: integrationConfig.config })
      .from(integrationConfig)
      .where(eq(integrationConfig.integrationId, integration.id))
      .limit(1);

    const existingConfig = (existing?.config as Record<string, unknown>) ?? {};
    const newConfig = { ...existingConfig, enabled: true };

    await db
      .insert(integrationConfig)
      .values({ id: randomUUID(), integrationId: integration.id, config: newConfig })
      .onConflictDoUpdate({
        target: integrationConfig.integrationId,
        set: { config: newConfig, updatedAt: new Date() },
      });

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetId: integration.id,
      targetType: "integration",
      action: "integration.enabled",
      request,
    });

    const reloadResult = await reloadIntegrations();
    return { ok: true, ...reloadResult };
  });

  // POST /admin/integrations/:id/disable
  app.post<{ Params: { id: string } }>(
    "/admin/integrations/:id/disable",
    async (request, reply) => {
      const integration = getIntegration(request.params.id);
      if (!integration) return reply.status(404).send({ error: "Integration not found" });

      const adminSession = getAdminSession(request);

      const [existing] = await db
        .select({ config: integrationConfig.config })
        .from(integrationConfig)
        .where(eq(integrationConfig.integrationId, integration.id))
        .limit(1);

      const existingConfig = (existing?.config as Record<string, unknown>) ?? {};
      const newConfig = { ...existingConfig, enabled: false };

      await db
        .insert(integrationConfig)
        .values({ id: randomUUID(), integrationId: integration.id, config: newConfig })
        .onConflictDoUpdate({
          target: integrationConfig.integrationId,
          set: { config: newConfig, updatedAt: new Date() },
        });

      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: integration.id,
        targetType: "integration",
        action: "integration.disabled",
        request,
      });

      const reloadResult = await reloadIntegrations();
      return { ok: true, ...reloadResult };
    },
  );

  app.post<{ Params: { id: string } }>("/admin/integrations/:id/reload", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const adminSession = getAdminSession(request);

    const jobId = await jobRunner.enqueue(
      "integration.reload",
      { integrationId: integration.id },
      adminSession.user.id,
    );

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetId: integration.id,
      targetType: "integration",
      action: "integration.reload",
      request,
    });

    return { ok: true, jobId };
  });

  // GET /admin/credentials — consolidated view across all integrations
  app.get("/admin/credentials", async () => {
    const all = getAllIntegrations();
    const allVault = await listAllSecrets();
    const vaultByIntegration = new Map<
      string,
      Array<{ key: string; updatedAt: Date; updatedBy: string | null }>
    >();
    for (const entry of allVault) {
      const list = vaultByIntegration.get(entry.integrationId) ?? [];
      list.push({ key: entry.key, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy });
      vaultByIntegration.set(entry.integrationId, list);
    }

    const result = all
      .filter((i) => getSecretFields(i.manifest.configSchema).length > 0)
      .map((i) => {
        const secretFields = getSecretFields(i.manifest.configSchema);
        const vaultList = vaultByIntegration.get(i.id) ?? [];
        const vaultMap = new Map(vaultList.map((v) => [v.key, v]));
        const missingSecrets = secretFields.filter((f) => {
          const envKey = integrationEnvVarName(i.id, f.key);
          return !vaultMap.has(f.key) && !process.env[envKey];
        });

        return {
          integrationId: i.id,
          name: getIntegrationDisplayName(i),
          enabled: i.enabled,
          secretFields: secretFields.length,
          vaultStored: vaultList.length,
          missingCredentials: missingSecrets.length,
        };
      });

    return { credentials: result, secretsConfigured: isSecretsConfigured() };
  });

  // GET /admin/credentials/:integrationId
  app.get<{ Params: { integrationId: string } }>(
    "/admin/credentials/:integrationId",
    async (request, reply) => {
      const integration = getIntegration(request.params.integrationId);
      if (!integration) return reply.status(404).send({ error: "Integration not found" });

      const credentialStatus = await computeCredentialStatus(integration);
      return {
        integrationId: integration.id,
        name: getIntegrationDisplayName(integration),
        credentials: credentialStatus,
        secretsConfigured: isSecretsConfigured(),
      };
    },
  );

  // PUT /admin/credentials/:integrationId/:key — set or rotate a secret
  app.put<{
    Params: { integrationId: string; key: string };
    Body: { value: string };
  }>("/admin/credentials/:integrationId/:key", async (request, reply) => {
    const { integrationId, key } = request.params;
    const integration = getIntegration(integrationId);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const adminSession = getAdminSession(request);

    const { value } = request.body ?? {};
    if (typeof value !== "string" || value.trim() === "") {
      return reply.status(400).send({ error: "value must be a non-empty string" });
    }

    if (!isSecretsConfigured()) {
      return reply.status(503).send({
        error: "Secrets vault not configured",
        hint: "Set OPENMAPX_SECRETS_KEY env var (openssl rand -hex 32)",
      });
    }

    // Validate the key exists in configSchema as a secret field
    const secretFields = getSecretFields(integration.manifest.configSchema);
    const isKnownSecret = secretFields.some((f) => f.key === key);
    if (!isKnownSecret) {
      return reply.status(400).send({
        error: `"${key}" is not a declared secret field for this integration`,
      });
    }

    await setSecret(integrationId, key, value, adminSession.user.id);

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetId: integrationId,
      targetType: "integration",
      action: "credential.set",
      details: { key },
      request,
    });

    // Reload so the running integration picks up the new secret. An
    // integration captures its resolved config (incl. vault secrets) once at
    // `setup(ctx)` load time, so without this a freshly-set key never reaches
    // the provider until the next restart. Mirrors the config-PATCH endpoint.
    const reloadResult = await reloadIntegrations();
    return { ok: true, ...reloadResult };
  });

  // DELETE /admin/credentials/:integrationId/:key
  app.delete<{ Params: { integrationId: string; key: string } }>(
    "/admin/credentials/:integrationId/:key",
    async (request, reply) => {
      const { integrationId, key } = request.params;
      const integration = getIntegration(integrationId);
      if (!integration) return reply.status(404).send({ error: "Integration not found" });

      const adminSession = getAdminSession(request);

      await deleteSecret(integrationId, key);

      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: integrationId,
        targetType: "integration",
        action: "credential.delete",
        details: { key },
        request,
      });

      // Reload so the running integration drops the removed secret (see the
      // set-secret handler above).
      const reloadResult = await reloadIntegrations();
      return { ok: true, ...reloadResult };
    },
  );

  // POST /admin/credentials/:integrationId/test — test credentials via health check
  app.post<{
    Params: { integrationId: string };
    Body: { key?: string };
  }>("/admin/credentials/:integrationId/test", async (request, reply) => {
    const { integrationId } = request.params;
    const integration = getIntegration(integrationId);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    if (!integration.manifest.healthCheck) {
      return reply.status(400).send({
        error: "This integration has no health check to validate credentials against",
      });
    }

    const results = await executeIntegrationHealthCheck(integration);
    if (results.length === 0) {
      return reply.status(500).send({ error: "Health check returned no result" });
    }

    const passed = results.every((r) => r.status === "up");
    const primary = results[0];
    return {
      ok: passed,
      integrationId,
      key: (request.body as { key?: string })?.key ?? null,
      status: passed ? "up" : primary.status,
      responseTime: primary.responseTime,
      error: results.find((r) => r.error)?.error ?? null,
    };
  });

  // GET /admin/integrations/:id/health/history — health timeline for an integration
  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>(
    "/admin/integrations/:id/health/history",
    async (request, reply) => {
      const integration = getIntegration(request.params.id);
      if (!integration) return reply.status(404).send({ error: "Integration not found" });

      const hours = Math.min(Number(request.query.hours ?? 24), 168); // max 7 days
      const timeline = await getTimeline(integration.id, hours);
      return {
        integrationId: integration.id,
        hours,
        timeline,
      };
    },
  );

  app.get("/admin/jobs", async (request, reply) => {
    const {
      status,
      limit = "50",
      offset = "0",
    } = request.query as {
      status?: string;
      limit?: string;
      offset?: string;
    };

    const validFilters = new Set<ActivityJobFilter>(["active", "completed", "failed"]);
    if (status && !validFilters.has(status as ActivityJobFilter)) {
      return reply.status(400).send({ error: "Invalid job status filter" });
    }

    const parsedLimit = Number.parseInt(limit, 10);
    const parsedOffset = Number.parseInt(offset, 10);
    return listActivityJobs({
      filter: status as ActivityJobFilter | undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : 0,
    });
  });

  app.get<{ Params: { id: string }; Querystring: { source?: ActivityJobSource } }>(
    "/admin/jobs/:id",
    async (request, reply) => {
      const source = request.query.source ?? "application";
      if (source !== "application" && source !== "data-manager") {
        return reply.status(400).send({ error: "Invalid job source" });
      }
      const job = await getActivityJob(request.params.id, source);
      if (!job) return reply.status(404).send({ error: "Job not found" });
      return job;
    },
  );

  app.post<{ Params: { id: string }; Querystring: { source?: ActivityJobSource } }>(
    "/admin/jobs/:id/cancel",
    async (request, reply) => {
      const source = request.query.source ?? "application";
      if (source !== "application" && source !== "data-manager") {
        return reply.status(400).send({ error: "Invalid job source" });
      }
      if (source === "data-manager") {
        return reply.status(400).send({ error: "Data-manager jobs cannot be canceled" });
      }
      const adminSession = getAdminSession(request);

      const canceled = await jobRunner.cancel(request.params.id);
      if (!canceled) {
        return reply.status(400).send({ error: "Job cannot be canceled (not running or queued)" });
      }

      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: request.params.id,
        targetType: "job",
        action: "job.cancel",
        request,
      });

      return { ok: true };
    },
  );

  app.get("/admin/integrations/export", async (request, _reply) => {
    const adminSession = getAdminSession(request);

    const configs = await db.select().from(integrationConfig);
    const exported = configs.map((c) => {
      const raw = (c.config ?? {}) as Record<string, unknown>;
      const integration = getIntegration(c.integrationId);
      return {
        integrationId: c.integrationId,
        config: maskSecretConfigRecord(raw, integration?.manifest.configSchema),
      };
    });

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "integration",
      targetId: "all",
      action: "integration.config.export",
      request,
    });

    return {
      integrations: exported,
      exportedAt: new Date().toISOString(),
      count: exported.length,
    };
  });

  app.post<{
    Body: { integrations: Array<{ integrationId: string; config: Record<string, unknown> }> };
  }>("/admin/integrations/import", async (request, reply) => {
    const adminSession = getAdminSession(request);

    const { integrations } = request.body ?? {};
    if (!Array.isArray(integrations)) {
      return reply.status(400).send({ error: "Body must have an 'integrations' array" });
    }

    let imported = 0;
    const skipped: string[] = [];
    for (const entry of integrations) {
      if (!entry.integrationId || typeof entry.config !== "object") continue;

      // Validate against the integration's configSchema if available
      const integration = getIntegration(entry.integrationId);
      if (!integration) {
        skipped.push(entry.integrationId);
        continue;
      }

      const schema = integration.manifest.configSchema as Record<string, unknown> | undefined;
      const props = schema
        ? ((schema.properties ?? schema) as Record<string, Record<string, unknown>>)
        : null;

      let filteredConfig: Record<string, unknown>;
      if (props) {
        // Only keep keys that exist in the schema and are not secrets
        filteredConfig = {};
        for (const [key, value] of Object.entries(entry.config)) {
          const def = props[key];
          if (!def || key === "type" || key === "properties") continue;
          if (def["x-openmapx-secret"]) continue;
          filteredConfig[key] = value;
        }
      } else {
        filteredConfig = entry.config;
      }

      await db
        .insert(integrationConfig)
        .values({
          id: randomUUID(),
          integrationId: entry.integrationId,
          config: filteredConfig as never,
        })
        .onConflictDoUpdate({
          target: integrationConfig.integrationId,
          set: { config: filteredConfig as never, updatedAt: new Date() },
        });
      imported++;
    }

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "integration",
      targetId: "all",
      action: "integration.config.import",
      details: { imported, skipped: skipped.length },
      request,
    });

    return { ok: true, imported, skipped };
  });

  app.get("/admin/audit", async (request) => {
    const {
      action,
      targetType,
      targetId,
      actorId,
      limit = "50",
      offset = "0",
    } = request.query as {
      action?: string;
      targetType?: string;
      targetId?: string;
      actorId?: string;
      limit?: string;
      offset?: string;
    };

    const where = buildAuditQuery({ action, targetType, targetId, actorId });
    const [entries, [countRow]] = await Promise.all([
      db
        .select()
        .from(adminAuditLog)
        .where(where)
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(Math.min(Number(limit), 200))
        .offset(Number(offset)),
      db.select({ total: count() }).from(adminAuditLog).where(where),
    ]);
    const actors = await resolveActors(entries.map((e) => e.actorId));
    return {
      entries: entries.map((e) => ({
        ...e,
        actor: e.actorId ? (actors.get(e.actorId) ?? null) : null,
      })),
      total: countRow?.total ?? 0,
    };
  });

  app.get("/admin/audit/export", async (request, reply) => {
    const { format, action, targetType, targetId, actorId } = request.query as {
      format?: string;
      action?: string;
      targetType?: string;
      targetId?: string;
      actorId?: string;
    };

    const where = buildAuditQuery({ action, targetType, targetId, actorId });
    // Fetch one more than the cap so we can detect (and flag) truncation.
    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(AUDIT_EXPORT_MAX_ROWS + 1);

    const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
    const entries = truncated ? rows.slice(0, AUDIT_EXPORT_MAX_ROWS) : rows;
    if (truncated) reply.header("X-Export-Truncated", "true");

    const dateStamp = new Date().toISOString().slice(0, 10);
    const isCsv = format === "csv";
    const ext = isCsv ? "csv" : "json";
    reply.header("Content-Disposition", `attachment; filename="audit-log-${dateStamp}.${ext}"`);

    if (isCsv) {
      const header = AUDIT_CSV_COLUMNS.join(",");
      const body = entries
        .map((e) => AUDIT_CSV_COLUMNS.map((col) => csvField(e[col])).join(","))
        .join("\n");
      reply.header("Content-Type", "text/csv; charset=utf-8");
      return reply.send(body ? `${header}\n${body}` : header);
    }

    const actors = await resolveActors(entries.map((e) => e.actorId));
    const enriched = entries.map((e) => ({
      ...e,
      actor: e.actorId ? (actors.get(e.actorId) ?? null) : null,
    }));
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(JSON.stringify(enriched));
  });
}
