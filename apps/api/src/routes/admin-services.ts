import { existsSync } from "node:fs";
import { SERVICE_RESOURCE_FIELDS } from "@openmapx/core/configuration-values";
import { type OpsResultFor, trustedConfigurationPayloadSchema } from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { isValidSecretKey } from "@openmapx/core/services/secret-key";
import {
  getSharedMobilityOperationsState,
  type SharedMobilityCategory,
  setSharedMobilityRollback,
} from "@openmapx/mobility-core/shared-mobility-orchestrator";
import type { FastifyInstance } from "fastify";
import {
  assertValidBackupName,
  getServiceSelectionSummary,
  validateServiceSelectionForWrite,
} from "../services/admin-cli";
import { inspectServiceConfiguration } from "../services/configuration-ownership-view";
import {
  DAWARICH_CREDENTIAL_MANAGED_CODE,
  DAWARICH_CREDENTIAL_MANAGED_ERROR,
  isProvisioningOwnedDawarichCredential,
} from "../services/dawarich/credential-policy.js";
import { hostControlConfigured, isSelfHostedDeployment } from "../services/deployment-mode";
import {
  createDirectAdminOpsKey,
  DIRECT_OPS_IDEMPOTENCY_HEADER,
  parseDirectOpsIdempotency,
} from "../services/direct-ops-idempotency";
import { jobRunner } from "../services/job-runner";
import {
  isManagedTransitCredential,
  managedServiceCredential,
  TRANSIT_CREDENTIAL_MANAGED_CODE,
} from "../services/managed-service-credentials";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../services/ops-client";
import { isSecretsConfigured } from "../services/secrets";
import { readServiceInventory } from "../services/service-inventory";
import { getServiceRegistry } from "../services/service-registry";
import { listServiceSecrets } from "../services/service-secrets";
import { applyTrustedConfiguration } from "../services/trusted-config-operations";
import { writeAuditLog } from "../utils/audit-log";
import { dockerComposeLogs } from "../utils/docker-compose";
import { maskSecretConfigValues } from "../utils/mask-config.js";
import { serviceActionLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth.js";
import { getSecretFields, validateConfigBody } from "../utils/validate-config-body";
import { registerServiceAdminRoute } from "./admin-service-contract";

const { serviceConfigEnvPrefix } = coreServices;
const BULK_SERVICE_ACTIONS = new Set(["start", "stop", "restart", "update", "build"] as const);

function hasOnlyBodyKeys(body: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    body === undefined ||
    (body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).every((key) => allowed.has(key)))
  );
}

type BackupInventory = OpsResultFor<"backup.list">;

async function loadBackupInventory(durableIdentity: string): Promise<BackupInventory> {
  return executeAndWait(
    createApiOpsClient(),
    { kind: "backup.list" },
    createDurableOpsKey("admin.backup.list", durableIdentity),
    { signal: AbortSignal.timeout(30_000) },
  );
}

function presentBackupInventory(inventory: BackupInventory) {
  return {
    backups: inventory.backups.map((backup) => ({
      name: backup.backupId,
      createdAt: backup.createdAt,
      ...(backup.expiresAt ? { expiresAt: backup.expiresAt } : {}),
      ...(backup.platformVersion ? { openmapxVersion: backup.platformVersion } : {}),
      serviceCount: backup.serviceCount,
      volumeCount: backup.volumeCount,
      totalBytes: backup.totalBytes,
      ...(backup.corrupt === true ? { corrupt: true, corruptReason: backup.corruptReason } : {}),
    })),
    warnings:
      inventory.warningCount === 0
        ? []
        : [`${inventory.warningCount} backup entries could not be validated`],
    root: "ops-agent-managed",
  };
}

export async function adminServicesRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  registerServiceAdminRoute(app, "getAdminSharedMobility", async () =>
    getSharedMobilityOperationsState(),
  );

  registerServiceAdminRoute(app, "rollbackAdminSharedMobility", async (req, reply) => {
    if (!(["bike", "scooter", "car"] as string[]).includes(req.params.category)) {
      reply.status(400);
      return { error: "Unknown shared-mobility category" };
    }
    if (typeof req.body?.enabled !== "boolean") {
      reply.status(400);
      return { error: "enabled must be a boolean" };
    }
    const category = req.params.category as SharedMobilityCategory;
    setSharedMobilityRollback(category, req.body.enabled);
    await writeAuditLog({
      action: "shared-mobility.rollback",
      actorId: getAdminSession(req).user.id,
      targetId: category,
      targetType: "shared-mobility-category",
      details: { enabled: req.body.enabled },
      request: req,
    });
    return getSharedMobilityOperationsState();
  });

  // GET /admin/services — list all services from registry with docker ps status
  registerServiceAdminRoute(app, "listAdminServices", async () => {
    return readServiceInventory();
  });

  registerServiceAdminRoute(app, "listAdminServicePresets", async (_req, reply) => {
    try {
      const loaded = getServiceRegistry().list();
      return {
        presets: Object.entries(coreServices.PRESETS).map(([id, rootIds]) => {
          const selection = coreServices.expandServiceSelection(loaded, rootIds);
          return {
            id,
            rootIds: [...rootIds],
            effectiveIds: [...selection.enabledIds],
            missingIds: selection.missingIds,
          };
        }),
      };
    } catch {
      return reply.code(503).send({ error: "Service registry not available" });
    }
  });

  // GET /admin/services/:id — single service detail
  registerServiceAdminRoute(app, "getAdminService", async (req, reply) => {
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
    const inventory = await readServiceInventory();
    const observed = inventory.services.find((row) => row.id === svc.manifest.id);
    if (!observed) {
      reply.status(503);
      return { error: "Service registry changed; retry the request" };
    }
    return {
      ...svc,
      status: observed.status,
      actions: observed.actions,
      acquisition: inventory.acquisition,
    };
  });

  // POST /admin/services/:id/action — start | stop | restart
  registerServiceAdminRoute(
    app,
    "runAdminServiceAction",
    async (req, reply) => {
      const { id } = req.params;
      const { action } = req.body;
      if (!["start", "stop", "restart", "apply"].includes(action)) {
        reply.status(400);
        return { error: "Invalid action — must be start | stop | restart | apply" };
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
      const coreRestart = action === "restart" && (id === "app-api" || id === "traefik");
      if (coreRestart) {
        try {
          const inventory = await executeAndWait(
            createApiOpsClient(),
            { kind: "services.inspect" },
            createDurableOpsKey("admin.core-restart.inspect", `${adminSession.user.id}:${id}`),
            { signal: AbortSignal.timeout(15_000) },
          );
          const decision = inventory.services.find((s) => s.serviceId === id)?.actions.restart;
          if (!decision?.available || decision.workflow !== "core-restart") {
            reply.status(503);
            return { error: "Core service restart is not available" };
          }
        } catch {
          reply.status(503);
          return { error: "Core service restart is not available" };
        }
      }
      const jobId = await jobRunner.enqueue(
        coreRestart ? "service.core-restart" : `service.${action}`,
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
    { beforeValidation: serviceActionLimit.preHandler() },
  );

  // GET /admin/services/selection — requested + effective selection roots
  registerServiceAdminRoute(app, "getAdminServiceSelection", async (_req, reply) => {
    let registry: ReturnType<typeof getServiceRegistry>;
    try {
      registry = getServiceRegistry();
    } catch {
      reply.status(503);
      return { error: "Service registry not available" };
    }
    return await getServiceSelectionSummary(registry);
  });

  // PUT /admin/services/selection — persist selected root services
  registerServiceAdminRoute(
    app,
    "setAdminServiceSelection",
    async (req, reply) => {
      let registry: ReturnType<typeof getServiceRegistry>;
      try {
        registry = getServiceRegistry();
      } catch {
        reply.status(503);
        return { error: "Service registry not available" };
      }

      const selectedRoots = [...new Set(req.body.selectedRoots)];
      let validated: Awaited<ReturnType<typeof validateServiceSelectionForWrite>>;
      try {
        validated = await validateServiceSelectionForWrite(registry, selectedRoots);
      } catch (err) {
        reply.status(400);
        return { error: (err as Error).message };
      }

      const operationKey = createDirectAdminOpsKey(
        getAdminSession(req).user.id,
        parseDirectOpsIdempotency(req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
      );
      const applied = await applyTrustedConfiguration({
        kind: "serviceSelection.apply",
        selectedRoots: validated.normalized,
        actorId: getAdminSession(req).user.id,
        operationKey,
      });
      const summary = await getServiceSelectionSummary(registry, validated.normalized);
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

      return { ok: true, revisionId: applied.revisionId, summary };
    },
    {
      beforeValidation: async (_request, reply) => {
        try {
          getServiceRegistry();
        } catch {
          return reply.code(503).send({ error: "Service registry not available" });
        }
      },
    },
  );

  // POST /admin/services/bulk-action — enqueue CLI-backed bulk service actions
  registerServiceAdminRoute(app, "runAdminServicesBulkAction", async (req, reply) => {
    const action = req.body?.action;
    if (!action || !BULK_SERVICE_ACTIONS.has(action)) {
      reply.status(400);
      return { error: "Invalid action (expected start|stop|restart|update|build)" };
    }
    const allowedKeys =
      action === "build"
        ? new Set([
            "action",
            "serviceIds",
            "all",
            "region",
            "continueOnError",
            "presetIds",
            "motisImport",
          ])
        : action === "update"
          ? new Set(["action", "serviceIds", "continueOnError", "noDeps", "presetIds"])
          : new Set(["action", "serviceIds", "continueOnError", "presetIds"]);
    if (!hasOnlyBodyKeys(req.body, allowedKeys)) {
      reply.status(400);
      return { error: "Request contains unsupported fields" };
    }

    let serviceIds: string[];
    try {
      serviceIds = [
        ...new Set([
          ...(req.body.serviceIds ?? []),
          ...coreServices.expandPresets(req.body.presetIds ?? []),
        ]),
      ];
      const registry = getServiceRegistry();
      if (serviceIds.some((id) => !registry.get(id)))
        return reply
          .code(400)
          .send({ error: "Selected preset or service contains an uninstalled service" });
      if (action === "build" && "motisImport" in req.body && req.body.motisImport) {
        const motis = registry.get("motis");
        if (
          !motis?.enabled ||
          !motis.isBuiltIn ||
          !motis.manifest.buildCommand ||
          !(serviceIds.includes("motis") || ("all" in req.body && req.body.all === true))
        )
          return reply
            .code(400)
            .send({ error: "MOTIS import requires a build including enabled built-in MOTIS" });
      }
    } catch (error) {
      if (error instanceof coreServices.UnknownPresetError)
        return reply.code(400).send({ error: "Unknown service preset" });
      return reply.code(503).send({ error: "Service registry not available" });
    }
    if (action !== "build" && serviceIds.length === 0) {
      reply.status(400);
      return { error: `Action "${action}" requires one or more serviceIds` };
    }
    if (
      action === "build" &&
      ("all" in req.body ? req.body.all : undefined) !== true &&
      serviceIds.length === 0
    ) {
      reply.status(400);
      return { error: 'Build action requires serviceIds or explicit "all": true' };
    }

    const region = "region" in req.body ? req.body.region?.trim() || undefined : undefined;
    const adminSession = getAdminSession(req);
    const jobId = await jobRunner.enqueue(
      "service.bulk",
      {
        action,
        serviceIds,
        all: ("all" in req.body ? req.body.all : undefined) === true,
        region,
        continueOnError: req.body?.continueOnError,
        ...("noDeps" in req.body ? { noDeps: req.body.noDeps } : {}),
        ...("motisImport" in req.body ? { motisImport: req.body.motisImport } : {}),
      },
      adminSession.user.id,
    );

    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "service",
      targetId: serviceIds.join(",") || "all",
      action: `service.bulk.${action}`,
      details: { serviceIds, all: ("all" in req.body ? req.body.all : undefined) === true, region },
      request: req,
    });

    return { ok: true, jobId };
  });

  // GET /admin/services/:id/config — schema + per-field resolved values with
  // sources. Mirrors the shape returned by the integration config endpoint so
  // the admin UI can render source badges (default / database / env) and
  // disable editing for fields currently overridden by `SERVICE_<ID>_<KEY>`
  // env vars on the host.
  registerServiceAdminRoute(app, "getAdminServiceConfig", async (req, reply) => {
    const svc = getServiceRegistry().get(req.params.id);
    if (!svc) {
      reply.status(404);
      return { error: "Service not found" };
    }
    // Reduce declared-secret fields to the "***" configured sentinel so a
    // credential never reaches the Config tab, mirroring the integration
    // detail route.
    const snapshot = await inspectServiceConfiguration(svc.manifest.id);
    const resolvedConfig = maskSecretConfigValues(snapshot.resolved, svc.manifest.configSchema);
    return {
      schema: svc.manifest.configSchema ?? null,
      resolvedConfig,
      envPrefix: serviceConfigEnvPrefix(svc.manifest.id),
      ownership: snapshot.ownership,
    };
  });

  // POST /admin/services/:id/config — merge per-service config updates (JSONB upsert)
  registerServiceAdminRoute(
    app,
    "updateAdminServiceConfig",
    async (req, reply) => {
      const svc = getServiceRegistry().get(req.params.id);
      if (!svc) {
        reply.status(404);
        return { error: "Service not found" };
      }
      const body = { ...req.body.config };
      const unset: string[] = [];
      const properties = svc.manifest.configSchema?.properties as
        | Record<string, { readOnly?: boolean; type?: string }>
        | undefined;
      for (const key of Object.keys(body)) {
        if (
          body[key] === null &&
          svc.isBuiltIn &&
          (SERVICE_RESOURCE_FIELDS as readonly string[]).includes(key) &&
          properties?.[key] &&
          properties[key].readOnly !== true &&
          !(
            Array.isArray(svc.manifest.configSchema?.required) &&
            svc.manifest.configSchema.required.includes(key)
          )
        ) {
          unset.push(key);
          delete body[key];
        }
      }
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
      await applyTrustedConfiguration({
        kind: "serviceConfig.apply",
        serviceId: req.params.id,
        actorId: adminSession.user.id,
        operationKey: createDirectAdminOpsKey(
          adminSession.user.id,
          parseDirectOpsIdempotency(req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
        ),
        overlay: {
          purpose: "service-config",
          coordinatorMode: "ensure-running",
          changes: [
            {
              kind: "service-config",
              serviceId: req.params.id,
              set: trustedConfigurationPayloadSchema.shape.serviceConfigs.element.shape.values.parse(
                config,
              ),
              unset,
            },
          ],
        },
      });
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: req.params.id,
        targetType: "service",
        action: "service.config.update",
        details: { keys: [...Object.keys(config), ...unset] },
        request: req,
      });
      return { ok: true };
    },
    {
      beforeValidation: async (req, reply) => {
        const { id } = req.params as { id: string };
        const svc = getServiceRegistry().get(id);
        if (!svc) return reply.code(404).send({ error: "Service not found" });
      },
    },
  );

  // Service credentials (the container vault). Mirrors the integration
  // credentials API, but applying a change re-renders the secret files and
  // replaces the service container (services bake env/secrets at create time — no live
  // reload). Requires Docker host-control; otherwise the caller gets
  // `needsRender` and must render + apply on the host.
  // GET /admin/services/:id/credentials — declared secret fields + per-field
  // status (vault | missing), setup guides, and who set each + when.
  registerServiceAdminRoute(app, "getAdminServiceCredentials", async (req, reply) => {
    const svc = getServiceRegistry().get(req.params.id);
    if (!svc) {
      reply.status(404);
      return { error: "Service not found" };
    }
    const fields = getSecretFields(svc.manifest.configSchema);
    const snapshot = await inspectServiceConfiguration(svc.manifest.id);
    const vault = await listServiceSecrets(svc.manifest.id);
    const vaultByKey = new Map(vault.map((v) => [v.key, v]));
    return {
      serviceId: svc.manifest.id,
      secretsConfigured: isSecretsConfigured(),
      credentials: fields.map((f) => {
        const v = vaultByKey.get(f.key);
        return {
          key: f.key,
          title: f.title,
          description: f.description,
          setup: f.setup,
          source:
            snapshot.resolved[f.key]?.value === undefined ||
            snapshot.resolved[f.key]?.value === null ||
            snapshot.resolved[f.key]?.value === ""
              ? ("missing" as const)
              : snapshot.resolved[f.key]!.source,
          ownership: snapshot.ownership[f.key],
          managedBy: managedServiceCredential(svc.manifest.id, f.key),
          updatedAt: v?.updatedAt?.toISOString(),
          updatedBy: v?.updatedBy ?? null,
        };
      }),
    };
  });

  // PUT /admin/services/:id/credentials/:key — set or rotate a secret.
  registerServiceAdminRoute(
    app,
    "setAdminServiceCredential",
    async (req, reply) => {
      const svc = getServiceRegistry().get(req.params.id);
      if (!svc) {
        reply.status(404);
        return { error: "Service not found" };
      }
      if (!isValidSecretKey(req.params.key)) {
        reply.status(400);
        return { error: "Invalid credential key" };
      }
      if (isManagedTransitCredential(svc.manifest.id, req.params.key))
        return reply.code(409).send({
          code: TRANSIT_CREDENTIAL_MANAGED_CODE,
          error: "Use the pinned transit feed credential workflow.",
        });
      if (isProvisioningOwnedDawarichCredential(svc.manifest.id, req.params.key)) {
        reply.status(409);
        return {
          code: DAWARICH_CREDENTIAL_MANAGED_CODE,
          error: DAWARICH_CREDENTIAL_MANAGED_ERROR,
        };
      }
      if (!isSecretsConfigured()) {
        reply.status(400);
        return { error: "Secret vault not configured — set OPENMAPX_SECRETS_KEY" };
      }
      const field = getSecretFields(svc.manifest.configSchema).find(
        (f) => f.key === req.params.key,
      );
      if (!field) {
        reply.status(400);
        return { error: `"${req.params.key}" is not a declared secret field of this service` };
      }
      const value = req.body?.value;
      if (typeof value !== "string" || value.trim() === "") {
        reply.status(400);
        return { error: "value must be a non-empty string" };
      }
      const adminSession = getAdminSession(req);
      const applied = await applyTrustedConfiguration({
        kind: "vault.apply",
        serviceId: svc.manifest.id,
        actorId: adminSession.user.id,
        followUp: "service-apply",
        operationKey: createDirectAdminOpsKey(
          adminSession.user.id,
          parseDirectOpsIdempotency(req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
        ),
        overlay: {
          purpose: "service-secret",
          coordinatorMode: "ensure-running",
          changes: [
            {
              kind: "service-secret",
              serviceId: svc.manifest.id,
              key: req.params.key,
              action: "set",
              value,
            },
          ],
        },
      });
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: svc.manifest.id,
        targetType: "service",
        action: "service.credential.set",
        details: { key: req.params.key },
        request: req,
      });
      return { ok: true as const, jobId: applied.jobId };
    },
    {
      beforeValidation: async (req, reply) => {
        const { id, key } = req.params as { id: string; key: string };
        const svc = getServiceRegistry().get(id);
        if (!svc) return reply.code(404).send({ error: "Service not found" });
        if (!isValidSecretKey(key))
          return reply.code(400).send({ error: "Invalid credential key" });
        if (isManagedTransitCredential(svc.manifest.id, key))
          return reply.code(409).send({
            code: TRANSIT_CREDENTIAL_MANAGED_CODE,
            error: "Use the pinned transit feed credential workflow.",
          });
        if (isProvisioningOwnedDawarichCredential(svc.manifest.id, key))
          return reply.code(409).send({
            code: DAWARICH_CREDENTIAL_MANAGED_CODE,
            error: DAWARICH_CREDENTIAL_MANAGED_ERROR,
          });
      },
    },
  );

  // DELETE /admin/services/:id/credentials/:key — remove a secret.
  registerServiceAdminRoute(
    app,
    "deleteAdminServiceCredential",
    async (req, reply) => {
      const svc = getServiceRegistry().get(req.params.id);
      if (!svc) {
        reply.status(404);
        return { error: "Service not found" };
      }
      if (!isValidSecretKey(req.params.key)) {
        reply.status(400);
        return { error: "Invalid credential key" };
      }
      if (isManagedTransitCredential(svc.manifest.id, req.params.key))
        return reply.code(409).send({
          code: TRANSIT_CREDENTIAL_MANAGED_CODE,
          error: "Use the pinned transit feed credential workflow.",
        });
      if (isProvisioningOwnedDawarichCredential(svc.manifest.id, req.params.key)) {
        reply.status(409);
        return {
          code: DAWARICH_CREDENTIAL_MANAGED_CODE,
          error: DAWARICH_CREDENTIAL_MANAGED_ERROR,
        };
      }
      // Mirror the PUT handler's declared-field check. A stored key can
      // legitimately outlive its declaration (the service's manifest changed
      // after the operator set it) and such rows still render into the secret
      // files, so removal must stay possible for anything actually held in the
      // vault — but not for a key that is neither declared nor stored.
      const declared = getSecretFields(svc.manifest.configSchema).some(
        (f) => f.key === req.params.key,
      );
      if (!declared) {
        const stored = await listServiceSecrets(svc.manifest.id);
        if (!stored.some((s) => s.key === req.params.key)) {
          reply.status(400);
          return { error: `"${req.params.key}" is not a declared secret field of this service` };
        }
      }
      const adminSession = getAdminSession(req);
      const applied = await applyTrustedConfiguration({
        kind: "vault.apply",
        serviceId: svc.manifest.id,
        actorId: adminSession.user.id,
        followUp: "service-apply",
        operationKey: createDirectAdminOpsKey(
          adminSession.user.id,
          parseDirectOpsIdempotency(req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]),
        ),
        overlay: {
          purpose: "service-secret",
          coordinatorMode: "ensure-running",
          changes: [
            {
              kind: "service-secret",
              serviceId: svc.manifest.id,
              key: req.params.key,
              action: "delete",
            },
          ],
        },
      });
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: svc.manifest.id,
        targetType: "service",
        action: "service.credential.delete",
        details: { key: req.params.key },
        request: req,
      });
      return { ok: true as const, jobId: applied.jobId };
    },
    {
      beforeValidation: async (req, reply) => {
        const { id, key } = req.params as { id: string; key: string };
        const svc = getServiceRegistry().get(id);
        if (!svc) return reply.code(404).send({ error: "Service not found" });
        if (!isValidSecretKey(key))
          return reply.code(400).send({ error: "Invalid credential key" });
        if (isManagedTransitCredential(svc.manifest.id, key))
          return reply.code(409).send({
            code: TRANSIT_CREDENTIAL_MANAGED_CODE,
            error: "Use the pinned transit feed credential workflow.",
          });
        if (isProvisioningOwnedDawarichCredential(svc.manifest.id, key))
          return reply.code(409).send({
            code: DAWARICH_CREDENTIAL_MANAGED_CODE,
            error: DAWARICH_CREDENTIAL_MANAGED_ERROR,
          });
      },
    },
  );

  // GET /admin/services/:id/logs — stream logs as plain text
  registerServiceAdminRoute(
    app,
    "streamAdminServiceLogs",
    async (req, reply) => {
      const adminSession = getAdminSession(req);
      let idempotencyValue: string;
      try {
        idempotencyValue = parseDirectOpsIdempotency(req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]);
      } catch (error) {
        reply.status(400);
        return { error: (error as Error).message };
      }
      const operationKey = createDirectAdminOpsKey(adminSession.user.id, idempotencyValue);
      await writeAuditLog({
        actorId: adminSession.user.id,
        targetId: req.params.id,
        targetType: "service",
        action: "service.logs.read",
        request: req,
      });
      const tail = Number(req.query.lines ?? 200);
      const follow = req.query.follow !== false && req.query.follow !== "false";
      const maxDurationSeconds = Number(req.query.maxDurationSeconds ?? 900);
      // Hijack bypasses Fastify header flushing; set the actual raw response.
      reply.raw.setHeader("Content-Type", "text/plain; charset=utf-8");
      reply.hijack();
      // Community and built-in services stream through the same typed
      // agent operation; the API no longer spawns a Docker log process.
      await dockerComposeLogs(req.params.id, reply.raw, {
        tail,
        follow,
        maxDurationSeconds,
        operationKey,
      });
      return reply;
    },
    {
      beforeValidation: async (req, reply) => {
        let registry: ReturnType<typeof getServiceRegistry>;
        try {
          registry = getServiceRegistry();
        } catch {
          reply.status(503);
          return reply.send({ error: "Service registry not available" });
        }
        const service = registry.get((req.params as { id: string }).id);
        if (!service) {
          reply.status(404);
          return reply.send({ error: `Service "${(req.params as { id: string }).id}" not found` });
        }
        try {
          parseDirectOpsIdempotency(req.headers[DIRECT_OPS_IDEMPOTENCY_HEADER]);
        } catch (error) {
          return reply.code(400).send({ error: (error as Error).message });
        }
      },
    },
  );

  // GET /admin/deployment — deployment mode detection
  registerServiceAdminRoute(app, "getAdminDeployment", async () => {
    const { INFRA_DIR, isDockerAvailable } = await import("../services/admin-ops");
    const dockerAvailable = await isDockerAvailable();
    const hostDir = process.env.OPENMAPX_HOST_DIR?.trim();
    return {
      selfHosted: isSelfHostedDeployment(),
      dockerAvailable,
      hostControlConfigured: hostControlConfigured(),
      hostDir: hostDir ?? null,
      // True once a configuration generation is applied: its render bakes the
      // applied services into app-api; a host-run API sees the generation.
      composeRendered:
        coreServices.parseServiceIdList(process.env[coreServices.APPLIED_SERVICES_ENV]) !== null ||
        existsSync(
          coreServices.currentConfigurationFile(INFRA_DIR, coreServices.GENERATED_COMPOSE_FILE),
        ),
      infraDir: INFRA_DIR,
    };
  });

  // POST /admin/services/check — docker compose ps summary
  registerServiceAdminRoute(app, "checkAdminServices", async (request) => {
    const adminSession = getAdminSession(request);
    const inventory = await readServiceInventory();
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "service",
      action: "service.health_check",
      request,
    });
    return {
      acquisition: inventory.acquisition,
      statuses: inventory.services.map((s) => ({ service: s.id, state: s.status })),
      checkedAt: new Date().toISOString(),
    };
  });

  // GET /admin/services/data — data inventory (OSM, builds, MOTIS health)
  registerServiceAdminRoute(app, "getAdminServiceData", async (request) => {
    const inventory = await executeAndWait(
      createApiOpsClient(),
      { kind: "data.inspect", ...request.query },
      createDurableOpsKey("admin.data.inspect", JSON.stringify(request.query)),
      { signal: AbortSignal.timeout(30_000) },
    );
    return {
      ...inventory,
      fetchedAt: new Date().toISOString(),
    };
  });

  // GET /admin/services/backups — list on-disk backup manifests
  registerServiceAdminRoute(app, "listAdminServiceBackups", async (req) => {
    const session = getAdminSession(req);
    return presentBackupInventory(await loadBackupInventory(`${session.user.id}:${req.id}`));
  });

  // POST /admin/services/backups — create backup job
  registerServiceAdminRoute(app, "createAdminServiceBackup", async (req, reply) => {
    if (!hasOnlyBodyKeys(req.body, new Set(["name"]))) {
      reply.status(400);
      return { error: "Request contains unsupported fields" };
    }
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
  registerServiceAdminRoute(app, "restoreAdminServiceBackup", async (req, reply) => {
    if (!hasOnlyBodyKeys(req.body, new Set(["serviceIds", "stopRunning"]))) {
      reply.status(400);
      return { error: "Request contains unsupported fields" };
    }
    const name = req.params.name.trim();
    try {
      assertValidBackupName(name);
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }

    const inventory = await loadBackupInventory(`${getAdminSession(req).user.id}:${req.id}`);
    const target = inventory.backups.find((backup) => backup.backupId === name);
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

    const serviceIds = [...new Set(req.body?.serviceIds ?? [])];
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
  registerServiceAdminRoute(app, "deleteAdminServiceBackup", async (req, reply) => {
    if (!hasOnlyBodyKeys(req.body, new Set())) {
      reply.status(400);
      return { error: "Request contains unsupported fields" };
    }
    const name = req.params.name.trim();
    try {
      assertValidBackupName(name);
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }

    const inventory = await loadBackupInventory(`${getAdminSession(req).user.id}:${req.id}`);
    if (!inventory.backups.some((backup) => backup.backupId === name)) {
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
