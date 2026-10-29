/** Strict coherent input collector; no job dispatch or candidate mutation. */
import {
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";

type PlatformConfiguration = coreServices.PlatformConfiguration;
const { platformConfigurationSchema, resolvePlatformConfiguration } = coreServices;

import { resolveIntegrationConfigWithSourcesStrict } from "../integration-config";
import {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
  withAdministrativeConfigurationRead,
} from "./administrative-configuration-writer";
import { projectIntegrationConfig } from "./integration-config-projection";
import { resolveAllServiceConfigsStrict } from "./service-config-resolver";
import { resolveServiceVaultSecretsStrict } from "./service-secrets";
import { transitCredentialRevision } from "./transit-credential-revision";

/**
 * Everything a render needs from the database, for every registered service:
 * a generation keeps what was saved for services that are not enabled, so
 * enabling one later, from here or the CLI, renders it with its settings.
 */
export async function buildConfigurationInput(
  context?: AdministrativeConfigurationReadContext,
  platform?: PlatformConfiguration,
): Promise<TrustedConfigurationPayload> {
  if (!context)
    return withAdministrativeConfigurationRead({}, (read) =>
      buildConfigurationInput(read, platform),
    );
  assertAdministrativeConfigurationRead(context);
  const services = context.services;
  const serviceConfigMap = await resolveAllServiceConfigsStrict(
    services.map((service) => ({
      id: service.manifest.id,
      configSchema: service.manifest.configSchema,
      containerEnv: service.manifest.container.environment,
      proxyHostConfigKey: service.manifest.exposure?.proxy?.host?.configKey,
    })),
    context,
  );
  const serviceSecrets = await Promise.all(
    services.map(async (service) => ({
      serviceId: service.manifest.id,
      values: await resolveServiceVaultSecretsStrict(service.manifest.id, context),
    })),
  );
  const integrations = context.integrations;
  const serviceIds = new Set(services.map((service) => service.manifest.id));
  const integrationIds = new Set(integrations.map((integration) => integration.id));
  if (
    context.serviceSecretRows.some((row) => !serviceIds.has(row.serviceId)) ||
    context.integrationRows.some((row) => !integrationIds.has(row.integrationId)) ||
    context.integrationSecretRows.some((row) => !integrationIds.has(row.integrationId))
  )
    throw new Error("Configuration acquisition unavailable");
  const integrationConfigs = await Promise.all(
    integrations.map(async (integration) => {
      const resolved = await resolveIntegrationConfigWithSourcesStrict(
        integration.manifest,
        integration.directory,
        context,
      );
      return {
        integrationId: integration.id,
        values: projectIntegrationConfig(
          integration.manifest.configSchema as Record<string, unknown> | undefined,
          Object.fromEntries(Object.entries(resolved).map(([key, entry]) => [key, entry.value])),
        ),
      };
    }),
  );
  return trustedConfigurationPayloadSchema.parse({
    domain: resolvePlatformConfiguration({ saved: platform, env: process.env }).values.domain,
    ...(platform ? { platform: platformConfigurationSchema.parse(platform) } : {}),
    serviceConfigs: services.map((service) => {
      const envKeys = serviceConfigMap.envKeys.get(service.manifest.id);
      return {
        serviceId: service.manifest.id,
        values: serviceConfigMap.values.get(service.manifest.id) ?? {},
        ...(envKeys ? { envKeys } : {}),
      };
    }),
    integrationConfigs,
    serviceSecrets,
    ...(context.serviceSecretRows.some(
      (row) => row.serviceId === "data-manager" && row.key === "TRANSITOUS_API_KEYS",
    )
      ? {
          transitCredentialsRevision: transitCredentialRevision(
            context.serviceSecretRows.find(
              (row) => row.serviceId === "data-manager" && row.key === "TRANSITOUS_API_KEYS",
            ),
          ),
        }
      : {}),
  });
}
