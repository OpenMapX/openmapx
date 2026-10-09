import {
  type OpsOperation,
  readOpsTokenFile,
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "@openmapx/core/ops";
import { envString } from "@openmapx/core/server-env";
import { db } from "../db";
import { integrationConfig } from "../db/schema";
import { getAllIntegrations } from "../integration-host";
import { createApiOpsClient, executeAndWait } from "./ops-client";
import { resolveAllServiceConfigs } from "./service-config-resolver";
import { getServiceRegistry } from "./service-registry";
import { resolveServiceVaultSecretsStrict } from "./service-secrets";
import {
  consumePublishedTrustedConfiguration,
  publishTrustedConfigurationSnapshot,
} from "./trusted-config-publisher";

type ConfigurationKind =
  | "stack.render"
  | "serviceSelection.apply"
  | "serviceConfig.apply"
  | "integrationConfig.apply"
  | "vault.apply";

export interface ApplyTrustedConfigurationOptions {
  kind: ConfigurationKind;
  operationKey: string;
  serviceId?: string;
  integrationId?: string;
  selectedRoots?: string[];
  signal?: AbortSignal;
}

function exactInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = env[name];
  if (!value || !/^(?:0|[1-9][0-9]{0,9})$/.test(value))
    throw new Error("Trusted configuration unavailable");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Trusted configuration unavailable");
  return parsed;
}

function nonSecretConfig(
  schema: Record<string, unknown> | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const properties = ((schema?.properties ?? schema) || {}) as Record<
    string,
    { "x-openmapx-secret"?: unknown }
  >;
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) =>
        key !== "type" &&
        key !== "properties" &&
        properties[key] &&
        properties[key]?.["x-openmapx-secret"] !== true,
    ),
  );
}

/**
 * Everything a render needs from the database, for every registered service:
 * a generation keeps what was saved for services that are not enabled, so
 * enabling one later, from here or the CLI, renders it with its settings.
 */
export async function buildConfigurationInput(): Promise<TrustedConfigurationPayload> {
  const services = getServiceRegistry().list();
  const serviceConfigMap = await resolveAllServiceConfigs(
    services.map((service) => ({
      id: service.manifest.id,
      configSchema: service.manifest.configSchema,
      containerEnv: service.manifest.container.environment,
      proxyHostConfigKey: service.manifest.exposure?.proxy?.host?.configKey,
    })),
  );
  const serviceSecrets = await Promise.all(
    services.map(async (service) => ({
      serviceId: service.manifest.id,
      values: await resolveServiceVaultSecretsStrict(service.manifest.id),
    })),
  );
  const integrations = getAllIntegrations();
  const configured = await db.select().from(integrationConfig);
  const configuredById = new Map(
    configured.map((entry) => [entry.integrationId, entry.config as Record<string, unknown>]),
  );
  return trustedConfigurationPayloadSchema.parse({
    domain: envString("DOMAIN", "localhost"),
    serviceConfigs: services.map((service) => {
      const envKeys = serviceConfigMap.envKeys.get(service.manifest.id);
      return {
        serviceId: service.manifest.id,
        values: serviceConfigMap.values.get(service.manifest.id) ?? {},
        ...(envKeys ? { envKeys } : {}),
      };
    }),
    integrationConfigs: integrations.map((integration) => ({
      integrationId: integration.id,
      values: nonSecretConfig(
        integration.manifest.configSchema as Record<string, unknown> | undefined,
        configuredById.get(integration.id) ?? {},
      ),
    })),
    serviceSecrets,
  });
}

/**
 * Hand the database's configuration to the ops-agent, which renders it with
 * the operator's selection (or `selectedRoots`, which become it) and makes it
 * the applied generation. The registry follows what was applied.
 */
export async function applyTrustedConfiguration(
  options: ApplyTrustedConfigurationOptions,
): Promise<{ revisionId: string; enabledServiceIds: string[] }> {
  if ((options.kind === "serviceSelection.apply") !== (options.selectedRoots !== undefined)) {
    throw new Error("Trusted configuration unavailable");
  }
  const payload = trustedConfigurationPayloadSchema.parse({
    ...(await buildConfigurationInput()),
    ...(options.selectedRoots ? { selectedRoots: options.selectedRoots } : {}),
  });
  const directory = process.env.OPS_TRUSTED_CONFIG_DIR;
  const tokenFile = process.env.OPS_AGENT_TOKEN_FILE;
  if (!directory || !tokenFile) throw new Error("Trusted configuration unavailable");
  const token = await readOpsTokenFile(tokenFile);
  const operationForRevision = (revisionId: string): OpsOperation => {
    switch (options.kind) {
      case "stack.render":
      case "serviceSelection.apply":
        return { kind: options.kind, revisionId };
      case "serviceConfig.apply":
      case "vault.apply":
        if (!options.serviceId) throw new Error("Trusted configuration unavailable");
        return { kind: options.kind, serviceId: options.serviceId, revisionId };
      case "integrationConfig.apply":
        if (!options.integrationId) throw new Error("Trusted configuration unavailable");
        return { kind: options.kind, integrationId: options.integrationId, revisionId };
    }
  };
  const sealed = await publishTrustedConfigurationSnapshot({
    directory,
    token,
    ownerUid: exactInteger(process.env, "OPS_TRUSTED_CONFIG_UID"),
    ownerGid: exactInteger(process.env, "OPS_TRUSTED_CONFIG_GID"),
    operationKey: options.operationKey,
    operationForRevision,
    payload,
  });
  const result = (await consumePublishedTrustedConfiguration(sealed, () =>
    executeAndWait(
      createApiOpsClient(),
      sealed.operation as Extract<OpsOperation, { revisionId: string }>,
      options.operationKey,
      { signal: options.signal },
    ),
  )) as { revisionId: string; enabledServiceIds: string[] };
  getServiceRegistry().applyEnabledIds(new Set(result.enabledServiceIds));
  return result;
}

/** The config schema of every loaded integration, by id. */
export function integrationSchemas(): Map<string, Record<string, unknown>> {
  return new Map(
    getAllIntegrations().map((integration) => [
      integration.id,
      (integration.manifest.configSchema ?? {}) as Record<string, unknown>,
    ]),
  );
}
