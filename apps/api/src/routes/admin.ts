import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import {
  adminAuditLog,
  adminJob,
  adminJobLog,
  integrationConfig,
  session,
  user,
} from "../db/schema";
import {
  getAllIntegrations,
  getIntegration,
  reloadIntegrations,
  resolveConfigWithSources,
} from "../integration-host";
import { getServiceStatuses, isDockerAvailable } from "../services/admin-ops";
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
import { healthCheckSweepLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";

const SENSITIVE_KEY_RE = /key|secret|token|password|credential|api_?key/i;

function getIntegrationDisplayName(integration: {
  id: string;
  manifest: { name?: string };
  strings: Record<string, Record<string, unknown>>;
}): string {
  const en = integration.strings.en as Record<string, unknown> | undefined;
  return (en?.name as string) ?? integration.manifest.name ?? integration.id;
}

function getEnvVarsSet(envVars: string[] | undefined): Record<string, boolean> {
  if (!envVars?.length) return {};
  return Object.fromEntries(envVars.map((v) => [v, !!(process.env[v] && process.env[v] !== "")]));
}

function isConfigured(envVars: string[] | undefined): boolean {
  if (!envVars?.length) return true;
  return envVars.every((v) => process.env[v] !== undefined && process.env[v] !== "");
}

function maskSensitiveConfig(
  resolvedConfig: Record<string, { value: unknown; source: string }>,
): Record<string, { value: unknown; source: string }> {
  const masked: Record<string, { value: unknown; source: string }> = {};
  for (const [key, entry] of Object.entries(resolvedConfig)) {
    if (SENSITIVE_KEY_RE.test(key) && entry.source !== "default") {
      masked[key] = { value: "***", source: entry.source };
    } else {
      masked[key] = entry;
    }
  }
  return masked;
}

/** Extract fields with x-openmapx-secret: true from a configSchema. */
function getSecretFields(configSchema?: Record<string, unknown>): Array<{
  key: string;
  title: string;
  description?: string;
  sharedSecretName?: string;
}> {
  if (!configSchema) return [];
  const props = (configSchema.properties ?? configSchema) as Record<
    string,
    Record<string, unknown>
  >;
  const result: Array<{
    key: string;
    title: string;
    description?: string;
    sharedSecretName?: string;
  }> = [];
  for (const [key, def] of Object.entries(props)) {
    if (key === "type" || key === "properties" || !def || typeof def !== "object") continue;
    if (def["x-openmapx-secret"] === true) {
      result.push({
        key,
        title: (def.title as string) ?? key,
        description: def.description as string | undefined,
        sharedSecretName: def["x-openmapx-sharedSecretName"] as string | undefined,
      });
    }
  }
  return result;
}

/** Compute credential status for an integration (secret fields + legacy envVars). */
async function computeCredentialStatus(integration: {
  id: string;
  manifest: {
    configSchema?: Record<string, unknown>;
    envVars?: string[];
  };
}): Promise<
  Array<{
    key: string;
    title: string;
    description?: string;
    source: "vault" | "env" | "missing";
    sharedSecretName?: string;
    updatedAt?: string;
    updatedBy?: string | null;
    isLegacyEnvVar: boolean;
  }>
> {
  const secretFields = getSecretFields(integration.manifest.configSchema);
  const vaultList = secretFields.length > 0 ? await listSecrets(integration.id) : [];
  const vaultMap = new Map(vaultList.map((v) => [v.key, v]));

  const result: Array<{
    key: string;
    title: string;
    description?: string;
    source: "vault" | "env" | "missing";
    sharedSecretName?: string;
    updatedAt?: string;
    updatedBy?: string | null;
    isLegacyEnvVar: boolean;
  }> = [];

  // Secret fields from configSchema
  for (const field of secretFields) {
    const vaultEntry = vaultMap.get(field.key);
    const envKey = `INTEGRATION_${integration.id.replace(/-/g, "_").toUpperCase()}_${field.key.toUpperCase()}`;
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
      updatedAt: vaultEntry?.updatedAt?.toISOString(),
      updatedBy: vaultEntry?.updatedBy ?? null,
      isLegacyEnvVar: false,
    });
  }

  // Legacy envVars not already covered by a secret field
  const secretFieldKeys = new Set(secretFields.map((f) => f.key));
  for (const envVar of integration.manifest.envVars ?? []) {
    if (secretFieldKeys.has(envVar)) continue;
    const hasEnv = !!(process.env[envVar] && process.env[envVar] !== "");
    result.push({
      key: envVar,
      title: envVar,
      source: hasEnv ? "env" : "missing",
      isLegacyEnvVar: true,
    });
  }

  return result;
}

export async function adminRoute(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return reply;
    request.adminSession = session;
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
      recentJobs,
      activeJobs,
      dockerServices,
    ] = await Promise.all([
      db.select({ total: count() }).from(user),
      db.select({ total: count() }).from(user).where(eq(user.banned, true)),
      db.select({ total: count() }).from(session).where(gt(session.updatedAt, twentyFourHoursAgo)),
      Promise.resolve(getAllIntegrations()),
      db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(10),
      db
        .select()
        .from(adminJob)
        .where(inArray(adminJob.status, ["success", "failed", "canceled"]))
        .orderBy(desc(adminJob.finishedAt))
        .limit(5),
      db
        .select()
        .from(adminJob)
        .where(inArray(adminJob.status, ["running", "queued"]))
        .orderBy(desc(adminJob.createdAt))
        .limit(5),
      selfHosted ? getServiceStatuses() : Promise.resolve([]),
    ]);

    const totalUsers = userRow?.total ?? 0;
    const bannedUsers = bannedRow?.total ?? 0;
    const activeSessions24h = activeSessionRow?.total ?? 0;

    const totalIntegrations = integrations.length;
    const enabledIntegrations = integrations.filter((i) => i.enabled).length;
    const unconfiguredIntegrations = integrations.filter(
      (i) => i.enabled && !isConfigured(i.manifest.envVars),
    ).length;
    const unhealthyIntegrations = integrations.filter((i) => {
      if (!i.enabled || !i.manifest.healthCheck) return false;
      const cached = getCachedHealthStatus(i.id);
      return cached?.status === "down";
    }).length;

    // Services summary (Docker only)
    const runningServices = dockerServices.filter((s) => s.state === "running").length;
    const stoppedServices = dockerServices.filter((s) => s.state === "stopped").length;
    const unhealthyServices = dockerServices.filter((s) => s.state === "unhealthy").length;

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

    // Missing credentials
    for (const i of integrations) {
      if (!i.enabled) continue;
      const secretFields = getSecretFields(i.manifest.configSchema);
      if (secretFields.length === 0 && !i.manifest.envVars?.length) continue;
      if (!isConfigured(i.manifest.envVars)) {
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

    // Failed jobs (in last 5)
    for (const job of recentJobs) {
      if (job.status === "failed") {
        attention.push({
          type: "job_failed",
          severity: "error",
          message: `Job "${job.type}" failed: ${job.error ?? "unknown error"}`,
          target: job.id,
        });
      }
    }

    // Unhealthy Docker services
    for (const svc of dockerServices) {
      if (svc.state === "unhealthy") {
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
      activeJobs: [...activeJobs, ...recentJobs],
    };
  });

  app.get("/admin/integrations", async () => {
    const all = getAllIntegrations();
    return all.map((integration) => {
      const cached = getCachedHealthStatus(integration.id);
      const envVars = integration.manifest.envVars;
      return {
        id: integration.id,
        name: getIntegrationDisplayName(integration),
        description: integration.manifest.description,
        version: integration.manifest.version,
        domains: integration.manifest.domains,
        quality: integration.manifest.quality ?? "built-in",
        isBuiltIn: integration.isBuiltIn,
        enabled: integration.enabled,
        configured: isConfigured(envVars),
        envVarsSet: getEnvVarsSet(envVars),
        hasHealthCheck: !!integration.manifest.healthCheck,
        health: cached
          ? { status: cached.status, responseTime: cached.responseTime, error: cached.error }
          : null,
        dependencies: integration.manifest.dependencies ?? [],
        infrastructure: integration.manifest.infrastructure ?? null,
      };
    });
  });

  app.get<{ Params: { id: string } }>("/admin/integrations/:id", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const [cached, resolvedRaw, credentialStatus] = await Promise.all([
      Promise.resolve(getCachedHealthStatus(integration.id)),
      resolveConfigWithSources(integration.manifest, integration.directory),
      computeCredentialStatus(integration),
    ]);

    const resolvedConfig = maskSensitiveConfig(resolvedRaw);
    const envVars = integration.manifest.envVars;

    const dependencyStatus = (integration.manifest.dependencies ?? []).map((depId) => {
      const dep = getIntegration(depId);
      return { id: depId, loaded: !!dep, enabled: dep?.enabled ?? false };
    });

    const envVarEntries = (envVars ?? []).map((name) => ({
      name,
      present: !!(process.env[name] && process.env[name] !== ""),
    }));

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
      configured: isConfigured(envVars),
      hasHealthCheck: !!integration.manifest.healthCheck,
      health: cached
        ? { status: cached.status, responseTime: cached.responseTime, error: cached.error }
        : null,
      dependencies: integration.manifest.dependencies ?? [],
      infrastructure: integration.manifest.infrastructure ?? null,
      manifest: integration.manifest,
      resolvedConfig,
      dependencyStatus,
      envVarEntries,
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

      const body = request.body;
      if (!body || typeof body !== "object") {
        return reply.status(400).send({ error: "Body must be a JSON object" });
      }

      const schema = integration.manifest.configSchema as Record<string, unknown> | undefined;
      const props = schema
        ? ((schema.properties ?? schema) as Record<string, Record<string, unknown>>)
        : {};

      const updates: Record<string, unknown> = {};
      const errors: string[] = [];

      for (const [key, value] of Object.entries(body)) {
        if (key === "type" || key === "properties") continue;
        const def = props[key] as Record<string, unknown> | undefined;

        if (!def) {
          errors.push(`Unknown config key: "${key}"`);
          continue;
        }
        if (def["x-openmapx-secret"]) {
          errors.push(`"${key}" is a secret field — use the credentials API instead`);
          continue;
        }
        if (key === "enabled") {
          errors.push(`"enabled" must be set via the enable/disable endpoints`);
          continue;
        }

        const type = def.type as string | undefined;
        if (type === "boolean" && typeof value !== "boolean") {
          errors.push(`"${key}" must be a boolean`);
          continue;
        }
        if ((type === "number" || type === "integer") && typeof value !== "number") {
          errors.push(`"${key}" must be a number`);
          continue;
        }
        if (type === "string" && typeof value !== "string") {
          errors.push(`"${key}" must be a string`);
          continue;
        }
        if (def.enum && !(def.enum as unknown[]).includes(value)) {
          errors.push(`"${key}" must be one of: ${(def.enum as unknown[]).join(", ")}`);
          continue;
        }

        updates[key] = value;
      }

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
      .filter((i) => {
        const secretFields = getSecretFields(i.manifest.configSchema);
        return secretFields.length > 0 || (i.manifest.envVars?.length ?? 0) > 0;
      })
      .map((i) => {
        const secretFields = getSecretFields(i.manifest.configSchema);
        const vaultList = vaultByIntegration.get(i.id) ?? [];
        const vaultMap = new Map(vaultList.map((v) => [v.key, v]));
        const envVarsSet = getEnvVarsSet(i.manifest.envVars);
        const missingSecrets = secretFields.filter((f) => {
          const envKey = `INTEGRATION_${i.id.replace(/-/g, "_").toUpperCase()}_${f.key.toUpperCase()}`;
          return !vaultMap.has(f.key) && !process.env[envKey];
        });

        return {
          integrationId: i.id,
          name: getIntegrationDisplayName(i),
          enabled: i.enabled,
          secretFields: secretFields.length,
          vaultStored: vaultList.length,
          missingCredentials: missingSecrets.length,
          envVarsSet,
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

    return { ok: true };
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

      return { ok: true };
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

  app.get("/admin/jobs", async (request) => {
    const {
      status,
      limit = "50",
      offset = "0",
    } = request.query as {
      status?: string;
      limit?: string;
      offset?: string;
    };

    const where = status ? eq(adminJob.status, status) : undefined;
    const [jobs, [countRow]] = await Promise.all([
      db
        .select()
        .from(adminJob)
        .where(where)
        .orderBy(desc(adminJob.createdAt))
        .limit(Math.min(Number(limit), 200))
        .offset(Number(offset)),
      db.select({ total: count() }).from(adminJob).where(where),
    ]);
    return { jobs, total: countRow?.total ?? 0 };
  });

  app.get<{ Params: { id: string } }>("/admin/jobs/:id", async (request, reply) => {
    const [job] = await db
      .select()
      .from(adminJob)
      .where(eq(adminJob.id, request.params.id))
      .limit(1);
    if (!job) return reply.status(404).send({ error: "Job not found" });

    const logs = await db
      .select()
      .from(adminJobLog)
      .where(eq(adminJobLog.jobId, request.params.id))
      .orderBy(asc(adminJobLog.seq));

    return { ...job, logs };
  });

  app.post<{ Params: { id: string } }>("/admin/jobs/:id/cancel", async (request, reply) => {
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
  });

  app.get("/admin/integrations/export", async (request, _reply) => {
    const adminSession = getAdminSession(request);

    const configs = await db.select().from(integrationConfig);
    const exported = configs.map((c) => {
      const raw = (c.config ?? {}) as Record<string, unknown>;
      const masked: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        masked[key] = SENSITIVE_KEY_RE.test(key) ? "***" : value;
      }
      return { integrationId: c.integrationId, config: masked };
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

    const conditions = [];
    if (action) conditions.push(eq(adminAuditLog.action, action));
    if (targetType) conditions.push(eq(adminAuditLog.targetType, targetType));
    if (targetId) conditions.push(eq(adminAuditLog.targetId, targetId));
    if (actorId) conditions.push(eq(adminAuditLog.actorId, actorId));

    const where = conditions.length ? and(...conditions) : undefined;
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
    return { entries, total: countRow?.total ?? 0 };
  });
}
