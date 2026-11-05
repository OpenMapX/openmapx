import { randomUUID } from "node:crypto";
import {
  type ConfigurationOwnership,
  configurationSourceOwnedSchema,
  configurationVersionConflictSchema,
} from "@openmapx/core/api-contracts";
import type { ConfigurationSourcesInspection } from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { integrationEnvVarName } from "@openmapx/integration-framework";
import { resolveIntegrationConfigWithSourcesStrict } from "../integration-config";
import {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
} from "./administrative-configuration-context";
import { integrationConfigRevision } from "./integration-runtime-evidence";
import { managedServiceCredential } from "./managed-service-credentials";
import { resolveServiceConfigWithSourcesStrict } from "./service-config-resolver";
import { resolveServiceVaultSecretsStrict } from "./service-secrets";
export class IntegrationConfigurationConflict extends Error {
  readonly code = "CONFIGURATION_VERSION_CONFLICT";
  constructor() {
    super("Configuration changed. Refresh before applying a new credential intent.");
  }
}
export class ConfigurationSourceOwned extends Error {
  readonly code = "CONFIGURATION_SOURCE_OWNED";
  constructor(readonly ownership: ConfigurationOwnership) {
    super(
      "This field is controlled by host configuration. Remove the host override, refresh, then explicitly save or rotate it.",
    );
  }
}
export function projectFieldOwnership(input: {
  source: ConfigurationOwnership["source"];
  secret: boolean;
  envVar?: string;
  managedBy?: ConfigurationOwnership["managedBy"];
  readOnly?: boolean;
}): ConfigurationOwnership {
  const host = input.source === "env" || input.source === "config.json";
  return {
    source: input.source,
    secret: input.secret,
    writable: !host && !input.managedBy && !input.readOnly,
    adoption: host || input.readOnly ? "host_action_required" : "direct",
    reason: host
      ? input.source === "env"
        ? "host_environment"
        : "host_file"
      : input.managedBy || input.readOnly
        ? "managed_workflow"
        : input.secret
          ? "vault_only"
          : null,
    ...(input.source === "env" && input.envVar ? { envVar: input.envVar } : {}),
    ...(input.managedBy ? { managedBy: input.managedBy } : {}),
  };
}
const definitions = (schema: Record<string, unknown> | undefined) =>
  (schema?.properties ?? schema ?? {}) as Record<
    string,
    { "x-openmapx-secret"?: boolean; readOnly?: boolean }
  >;
export async function integrationOwnershipSnapshot(
  integrationId: string,
  context: AdministrativeConfigurationReadContext,
) {
  assertAdministrativeConfigurationRead(context);
  const integration = context.integrations.find((i) => i.id === integrationId);
  if (!integration) throw Error("Integration unavailable");
  const resolved = await resolveIntegrationConfigWithSourcesStrict(
      integration.manifest,
      integration.directory,
      context,
    ),
    fields: ReturnType<typeof definitions> = {
      ...definitions(integration.manifest.configSchema),
      enabled: {},
    };
  const ownership = Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => !["type", "properties"].includes(key))
      .map(([key, definition]) => [
        key,
        projectFieldOwnership({
          source: resolved[key]?.source ?? "default",
          secret: definition["x-openmapx-secret"] === true,
          readOnly: definition.readOnly,
          envVar: integrationEnvVarName(integrationId, key),
        }),
      ]),
  );
  const revision = integrationConfigRevision({
    integrationId,
    resolved,
    rows: context.integrationRows.filter((row) => row.integrationId === integrationId),
    vault: context.integrationSecretRows.filter((row) => row.integrationId === integrationId),
  });
  return { ownership, resolved, revision };
}
export async function inspectIntegrationConfiguration(integrationId: string) {
  const { withAdministrativeConfigurationRead } = await import(
    "./administrative-configuration-writer-owner"
  );
  return withAdministrativeConfigurationRead({}, async (read) =>
    integrationOwnershipSnapshot(integrationId, read),
  );
}
export async function serviceOwnershipSnapshot(
  serviceId: string,
  context: AdministrativeConfigurationReadContext,
  source: ConfigurationSourcesInspection,
) {
  assertAdministrativeConfigurationRead(context);
  const service = context.services.find((s) => s.manifest.id === serviceId);
  if (!service) throw Error("Service unavailable");
  const resolved = await resolveServiceConfigWithSourcesStrict(
      {
        id: serviceId,
        configSchema: service.manifest.configSchema,
        containerEnv: service.manifest.container.environment,
        containerMemory: service.manifest.container.memory,
        isBuiltIn: service.isBuiltIn,
      },
      context,
    ),
    vault = await resolveServiceVaultSecretsStrict(serviceId, context),
    properties = definitions(service.manifest.configSchema);
  const ownership: Record<string, ConfigurationOwnership> = {};
  for (const [key, definition] of Object.entries(properties)) {
    if (["type", "properties"].includes(key)) continue;
    const secret = definition["x-openmapx-secret"] === true,
      host = source.services
        .find((s) => s.serviceId === serviceId)
        ?.fields.find((field) => field.key === key);
    if (secret && Object.hasOwn(vault, key) && resolved[key]?.source !== "env")
      resolved[key] = { value: vault[key], source: "vault" };
    if (host?.source === "host") resolved[key] = { value: null, source: "env" };
    ownership[key] = projectFieldOwnership({
      source: resolved[key]?.source ?? "default",
      secret,
      readOnly: definition.readOnly,
      envVar:
        host?.envVar ?? `${coreServices.serviceConfigEnvPrefix(serviceId)}${key.toUpperCase()}`,
      managedBy: managedServiceCredential(serviceId, key),
    });
  }
  // Even an undeclared retained managed key remains protected.
  for (const key of Object.keys(vault))
    if (!ownership[key] && managedServiceCredential(serviceId, key))
      ownership[key] = projectFieldOwnership({
        source: "vault",
        secret: true,
        managedBy: managedServiceCredential(serviceId, key),
      });
  return { ownership, resolved };
}
export async function inspectServiceConfiguration(serviceId: string) {
  const { withAdministrativeConfigurationRead } = await import(
    "./administrative-configuration-writer-owner"
  );
  const { createApiOpsClient, createDurableOpsKey, executeAndWait } = await import("./ops-client");
  return withAdministrativeConfigurationRead({}, async (read) => {
    const source = await executeAndWait(
      createApiOpsClient(),
      { kind: "configuration.sources.inspect" },
      createDurableOpsKey("configuration.sources.inspect", randomUUID()),
    );
    return serviceOwnershipSnapshot(serviceId, read, source);
  });
}

export async function inspectIntegrationOwnership(id: string) {
  return (await inspectIntegrationConfiguration(id)).ownership;
}
export async function inspectServiceOwnership(id: string) {
  return (await inspectServiceConfiguration(id)).ownership;
}

export function configurationRejection(error: unknown) {
  return error instanceof ConfigurationSourceOwned
    ? { code: error.code, error: error.message, ownership: error.ownership }
    : error instanceof IntegrationConfigurationConflict
      ? { code: error.code, error: error.message }
      : null;
}
export function restoreConfigurationRejection(value: unknown): Error {
  const owned = configurationSourceOwnedSchema.safeParse(value);
  if (owned.success) return new ConfigurationSourceOwned(owned.data.ownership);
  if (configurationVersionConflictSchema.safeParse(value).success)
    return new IntegrationConfigurationConflict();
  return Error("Configuration rejection unavailable");
}
