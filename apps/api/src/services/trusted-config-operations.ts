import {
  configurationGenerationRevisionSchema,
  type OpsOperation,
  readOpsTokenFile,
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "@openmapx/core/ops";
import { envString } from "@openmapx/core/server-env";
import { db } from "../db";
import { integrationConfig } from "../db/schema";
import { getAllIntegrations } from "../integration-host";
import { projectIntegrationConfig } from "./integration-config-projection";
import { createApiOpsClient, executeTrustedConfigurationAndWait } from "./ops-client";
import { resolveAllServiceConfigs } from "./service-config-resolver";
import { getServiceRegistry } from "./service-registry";
import { resolveServiceVaultSecretsStrict } from "./service-secrets";
import {
  TrustedConfigurationApplyError,
  type TrustedConfigurationApplyOutcome,
} from "./trusted-config-outcome";
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
      values: projectIntegrationConfig(
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
  const { outcome } = await applyTrustedConfigurationWithEvidence(options);
  if (
    outcome.outcome !== "committed" ||
    outcome.followUp !== "complete" ||
    outcome.cleanupFailed ||
    outcome.publisherCleanupFailed ||
    outcome.registryUpdateFailed
  )
    throw new TrustedConfigurationApplyError(outcome);
  return { revisionId: outcome.revisionId, enabledServiceIds: outcome.enabledServiceIds };
}

/** Internal evidence for scoped compensation. Payload may contain secrets; never serialize it. */
export async function applyTrustedConfigurationWithEvidence(
  options: ApplyTrustedConfigurationOptions,
): Promise<{ payload?: TrustedConfigurationPayload; outcome: TrustedConfigurationApplyOutcome }> {
  let payload: TrustedConfigurationPayload;
  try {
    if ((options.kind === "serviceSelection.apply") !== (options.selectedRoots !== undefined)) {
      throw new Error("Trusted configuration unavailable");
    }
    payload = trustedConfigurationPayloadSchema.parse({
      ...(await buildConfigurationInput()),
      ...(options.selectedRoots ? { selectedRoots: options.selectedRoots } : {}),
    });
  } catch {
    return {
      outcome: {
        outcome: "not_committed",
        reason: "failed",
        cleanupFailed: false,
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      },
    };
  }
  return { payload, outcome: await applySnapshot(options, payload) };
}

/** Full-snapshot compensation; compare the applied generation, NOT the manifest authority. */
export async function applyTrustedConfigurationSnapshot(options: {
  payload: TrustedConfigurationPayload;
  expectedCurrentRevisionId: string | null;
  operationKey: string;
  signal?: AbortSignal;
}): Promise<TrustedConfigurationApplyOutcome> {
  if (
    !configurationGenerationRevisionSchema.nullable().safeParse(options.expectedCurrentRevisionId)
      .success
  ) {
    return {
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    };
  }
  return applySnapshot(
    { kind: "stack.render", operationKey: options.operationKey, signal: options.signal },
    options.payload,
    options.expectedCurrentRevisionId,
  );
}

async function applySnapshot(
  options: ApplyTrustedConfigurationOptions,
  input: TrustedConfigurationPayload,
  expectedCurrentRevisionId?: string | null,
): Promise<TrustedConfigurationApplyOutcome> {
  let submitted = false;
  try {
    const payload = trustedConfigurationPayloadSchema.parse(input);
    const directory = process.env.OPS_TRUSTED_CONFIG_DIR;
    const tokenFile = process.env.OPS_AGENT_TOKEN_FILE;
    if (!directory || !tokenFile) throw new Error("Trusted configuration unavailable");
    const token = await readOpsTokenFile(tokenFile);
    const operationForRevision = (revisionId: string): OpsOperation => {
      switch (options.kind) {
        case "stack.render":
          return {
            kind: options.kind,
            revisionId,
            ...(expectedCurrentRevisionId !== undefined ? { expectedCurrentRevisionId } : {}),
          };
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
    const consumed = await consumePublishedTrustedConfiguration(sealed, () => {
      const client = createApiOpsClient();
      submitted = true;
      return executeTrustedConfigurationAndWait(
        client,
        sealed.operation as Extract<OpsOperation, { revisionId: string }>,
        options.operationKey,
        { signal: options.signal },
      );
    });
    const result =
      consumed.submission.status === "fulfilled"
        ? consumed.submission.value
        : submitted
          ? { outcome: "unknown" as const, reason: "transport_or_result" as const }
          : { outcome: "not_committed" as const, reason: "failed" as const, cleanupFailed: false };
    let registryUpdateFailed = false;
    if (result.outcome === "committed") {
      try {
        getServiceRegistry().applyEnabledIds(new Set(result.enabledServiceIds));
      } catch {
        registryUpdateFailed = true;
      }
    }
    return { ...result, publisherCleanupFailed: consumed.cleanupFailed, registryUpdateFailed };
  } catch {
    // Publication/preparation failed before execute, or an unexpected error after submission.
    return {
      ...(submitted
        ? { outcome: "unknown" as const, reason: "transport_or_result" as const }
        : { outcome: "not_committed" as const, reason: "failed" as const, cleanupFailed: false }),
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    };
  }
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
