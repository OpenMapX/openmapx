import type { FastifyInstance } from "fastify";
import { getAllIntegrations, getIntegration, reloadIntegrations } from "../integration-host";
import {
  computeCredentialStatus,
  getIntegrationDisplayName,
} from "../services/integration-credential-status";
import { executeIntegrationHealthCheck } from "../services/integration-health";
import { deleteSecret, isSecretsConfigured, listSecrets, setSecret } from "../services/secrets";
import { writeAuditLog } from "../utils/audit-log";
import { getAdminSession } from "../utils/require-admin";
import { getSecretFields } from "../utils/validate-config-body";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

export async function adminIntegrationCredentialsRoute(app: FastifyInstance): Promise<void> {
  // GET /admin/credentials — consolidated view across all integrations
  registerIntegrationAdminRoute(app, "listAdminCredentials", async () => {
    const result = await Promise.all(
      getAllIntegrations()
        .filter((i) => getSecretFields(i.manifest.configSchema).length > 0)
        .map(async (i) => {
          const [statuses, vault] = await Promise.all([
            computeCredentialStatus(i),
            listSecrets(i.id),
          ]);
          return {
            integrationId: i.id,
            name: getIntegrationDisplayName(i),
            enabled: i.enabled,
            secretFields: statuses.length,
            vaultStored: vault.length,
            missingCredentials: statuses.filter((s) => s.source === "missing").length,
          };
        }),
    );

    return { credentials: result, secretsConfigured: isSecretsConfigured() };
  });

  // GET /admin/credentials/:integrationId
  registerIntegrationAdminRoute(app, "getAdminIntegrationCredentials", async (request, reply) => {
    const integration = getIntegration(request.params.integrationId);
    if (!integration) return reply.status(404).send({ error: "Integration not found" });

    const credentialStatus = await computeCredentialStatus(integration);
    return {
      integrationId: integration.id,
      name: getIntegrationDisplayName(integration),
      credentials: credentialStatus,
      secretsConfigured: isSecretsConfigured(),
    };
  });

  // PUT /admin/credentials/:integrationId/:key — set or rotate a secret
  registerIntegrationAdminRoute(app, "setAdminIntegrationCredential", async (request, reply) => {
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
  registerIntegrationAdminRoute(app, "deleteAdminIntegrationCredential", async (request, reply) => {
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
  });

  // POST /admin/credentials/:integrationId/test — test credentials via health check
  registerIntegrationAdminRoute(app, "testAdminIntegrationCredentials", async (request, reply) => {
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
}
