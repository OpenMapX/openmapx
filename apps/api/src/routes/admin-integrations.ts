import { adminIntegrationJsonObjectSchema } from "@openmapx/core/api-contracts";
import { integrationEnvVarName } from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { integrationConfig } from "../db/schema";
import { getAllIntegrations, getIntegration, resolveConfigWithSources } from "../integration-host";
import {
  createDirectAdminOpsKey,
  DIRECT_OPS_IDEMPOTENCY_HEADER,
  parseDirectOpsIdempotency,
} from "../services/direct-ops-idempotency";
import { getTimeline } from "../services/health-history";
import {
  exportIntegrationConfigs,
  IntegrationImportValidationError,
  prepareIntegrationImport,
} from "../services/integration-config-import";
import {
  computeCredentialStatus,
  getIntegrationDisplayName,
} from "../services/integration-credential-status";
import {
  executeAllIntegrationHealthChecks,
  executeIntegrationHealthCheck,
  getCachedHealthStatus,
} from "../services/integration-health";
import { jobRunner } from "../services/job-runner";
import { isSecretsConfigured } from "../services/secrets";
import {
  applyTrustedConfiguration,
  integrationSchemas,
} from "../services/trusted-config-operations";
import { writeAuditLog } from "../utils/audit-log";
import { maskSecretConfigValues } from "../utils/mask-config.js";
import { healthCheckSweepLimit } from "../utils/rate-limit";
import { getAdminSession } from "../utils/require-admin";
import { validateConfigBody } from "../utils/validate-config-body";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

async function persistAndApplyIntegrationConfig(options: {
  integrationId: string;
  config: Record<string, unknown>;
  actorId: string;
  operationKey: string;
}): Promise<import("../services/trusted-config-operations").CapturedIntegrationReloadResult> {
  const applied = await applyTrustedConfiguration({
    kind: "integrationConfig.apply",
    integrationId: options.integrationId,
    actorId: options.actorId,
    operationKey: options.operationKey,
    overlay: {
      purpose: "integration-config",
      coordinatorMode: "ensure-running",
      changes: [
        {
          kind: "integration-config",
          integrationId: options.integrationId,
          set: adminIntegrationJsonObjectSchema.parse(options.config),
          unset: [],
        },
      ],
    },
  });
  if (!applied.integrationReload) throw Error("Captured integration reload unavailable");
  return applied.integrationReload;
}

export async function adminIntegrationsRoute(app: FastifyInstance): Promise<void> {
  registerIntegrationAdminRoute(app, "listAdminIntegrations", async () => {
    const all = getAllIntegrations();
    return Promise.all(
      all.map(async (integration) => {
        const cached = getCachedHealthStatus(integration.id);
        const statuses = await computeCredentialStatus(integration);
        // `configured` is true when every declared secret has an effective
        // resolved value (or when the integration declares no secrets at all).
        const configured = statuses.every((s) => s.source !== "missing");
        return {
          id: integration.id,
          name: getIntegrationDisplayName(integration),
          description: integration.manifest.description,
          version: integration.manifest.version,
          domains: integration.manifest.domains,
          quality: integration.manifest.quality ?? "built-in",
          isBuiltIn: integration.isBuiltIn,
          blockedCode: integration.blockedCode === true,
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
  registerIntegrationAdminRoute(app, "listAdminIntegrationEnvVars", async () => {
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

  registerIntegrationAdminRoute(app, "getAdminIntegration", async (request, reply) => {
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

    // Every declared secret has an effective resolved value (or the integration
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
      blockedCode: integration.blockedCode === true,
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

  registerIntegrationAdminRoute(app, "getAdminIntegrationHealth", async (request, reply) => {
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

  registerIntegrationAdminRoute(
    app,
    "runAdminIntegrationHealthChecks",
    async () => {
      const all = getAllIntegrations().filter((i) => i.enabled);
      const results = await executeAllIntegrationHealthChecks(all);
      return { timestamp: new Date().toISOString(), count: results.length, results };
    },
    { preHandler: [healthCheckSweepLimit.preHandler()] },
  );

  registerIntegrationAdminRoute(app, "reloadAdminIntegrations", async (request, _reply) => {
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
  registerIntegrationAdminRoute(app, "patchAdminIntegrationConfig", async (request, reply) => {
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

    const reloadResult = await persistAndApplyIntegrationConfig({
      integrationId: integration.id,
      config: updates,
      actorId: adminSession.user.id,
      operationKey: createDirectAdminOpsKey(
        adminSession.user.id,
        parseDirectOpsIdempotency(request.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
      ),
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
    return { ok: true, updated: Object.keys(updates), ...reloadResult };
  });

  // POST /admin/integrations/:id/enable
  registerIntegrationAdminRoute(app, "enableAdminIntegration", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const adminSession = getAdminSession(request);

    const reloadResult = await persistAndApplyIntegrationConfig({
      integrationId: integration.id,
      config: { enabled: true },
      actorId: adminSession.user.id,
      operationKey: createDirectAdminOpsKey(
        adminSession.user.id,
        parseDirectOpsIdempotency(request.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
      ),
    });

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetId: integration.id,
      targetType: "integration",
      action: "integration.enabled",
      request,
    });

    return { ok: true, ...reloadResult };
  });

  // POST /admin/integrations/:id/disable
  registerIntegrationAdminRoute(app, "disableAdminIntegration", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const adminSession = getAdminSession(request);

    const reloadResult = await persistAndApplyIntegrationConfig({
      integrationId: integration.id,
      config: { enabled: false },
      actorId: adminSession.user.id,
      operationKey: createDirectAdminOpsKey(
        adminSession.user.id,
        parseDirectOpsIdempotency(request.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
      ),
    });

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetId: integration.id,
      targetType: "integration",
      action: "integration.disabled",
      request,
    });

    return { ok: true, ...reloadResult };
  });

  registerIntegrationAdminRoute(app, "reloadAdminIntegration", async (request, reply) => {
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

  // GET /admin/integrations/:id/health/history — health timeline for an integration
  registerIntegrationAdminRoute(app, "getAdminIntegrationHealthHistory", async (request, reply) => {
    const integration = getIntegration(request.params.id);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const hours = request.query.hours;
    const timeline = await getTimeline(integration.id, hours);
    return {
      integrationId: integration.id,
      hours,
      timeline: timeline.map((row) => ({
        ...row,
        hour: new Date(
          /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(row.hour)
            ? `${row.hour.replace(" ", "T")}Z`
            : row.hour,
        ).toISOString(),
      })),
    };
  });

  registerIntegrationAdminRoute(app, "exportAdminIntegrationConfigs", async (request, _reply) => {
    const adminSession = getAdminSession(request);

    const exported = exportIntegrationConfigs(
      await db.select().from(integrationConfig),
      integrationSchemas(),
    );

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "integration",
      targetId: "all",
      action: "integration.config.export",
      request,
    });

    return exported;
  });

  registerIntegrationAdminRoute(app, "importAdminIntegrationConfigs", async (request, reply) => {
    const adminSession = getAdminSession(request);

    const schemas = integrationSchemas();
    let entries: ReturnType<typeof prepareIntegrationImport>;
    try {
      entries = prepareIntegrationImport(request.body, schemas);
    } catch (error) {
      return reply.status(400).send({
        errors:
          error instanceof IntegrationImportValidationError
            ? error.errors
            : ["Invalid integration import"],
      });
    }
    const operationKey = createDirectAdminOpsKey(
      adminSession.user.id,
      parseDirectOpsIdempotency(request.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
    );
    const result = await jobRunner.importImmediateIntegrationConfiguration({
      body: { integrations: entries },
      actorId: adminSession.user.id,
      operationKey,
    });
    if (!result.ok) return reply.status(409).send(result);
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "integration",
      targetId: "all",
      action: "integration.config.import",
      details: { imported: result.imported },
      request,
    });
    return result;
  });
}
