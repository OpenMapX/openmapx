import {
  type OpsOperation,
  opsOperationFingerprint,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import type { OpsRuntime, OpsTrustedClaim } from "./runtime";

const FAILED = "Trusted configuration apply failed";
type TrustedConfigurationOperation = Extract<OpsOperation, { revisionId: string }>;

export interface TrustedConfigurationRuntimeOptions {
  services: readonly coreServices.LoadedService[];
  integrationSchemas: ReadonlyMap<string, Record<string, unknown>>;
  loadAuthority?: () => Promise<TrustedConfigurationAuthoritySnapshot>;
  infraDir: string;
  /** The process environment, read for the operator's selection override. */
  env?: NodeJS.ProcessEnv;
  beforeCommit?: () => Promise<void>;
  afterGenerationRename?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}

export interface TrustedConfigurationAuthoritySnapshot {
  revisionId: string;
  services: readonly coreServices.LoadedService[];
  integrationSchemas: ReadonlyMap<string, Record<string, unknown>>;
}

/** The enabled services of the applied generation, or null before the first render. */
export function readTrustedEnabledServiceIds(
  infraDir: string,
  services: readonly coreServices.LoadedService[],
): ReadonlySet<string> | null {
  try {
    return coreServices.readAppliedServiceIds(infraDir, services);
  } catch {
    throw new Error(FAILED);
  }
}

export async function initializeTrustedConfigurationRuntime(infraDir: string): Promise<void> {
  try {
    await coreServices.initializeConfigurationGenerations(infraDir);
  } catch {
    throw new Error(FAILED);
  }
}

async function commitGeneration(
  options: TrustedConfigurationRuntimeOptions,
  operation: TrustedConfigurationOperation,
  payload: TrustedConfigurationPayload,
  claim: OpsTrustedClaim,
): Promise<{ revisionId: string; enabledServiceIds: string[] }> {
  try {
    const authority = await options.loadAuthority?.();
    if (
      authority &&
      (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authority.revisionId) ||
        claim.capability.values.authorityRevision !== authority.revisionId)
    ) {
      throw new Error(FAILED);
    }
    const services = authority?.services ?? options.services;
    const env = options.env ?? process.env;
    let selectedRoots: string[];
    let allowMissingSelected = false;
    if (operation.kind === "serviceSelection.apply") {
      // A new selection is the operator's desired one from now on, for the CLI
      // too. It is persisted before it is applied, so an interrupted apply is
      // completed by the next render rather than undone.
      const desired = coreServices.readDesiredSelection(options.infraDir, env);
      if (!payload.selectedRoots || desired.source === "env") throw new Error(FAILED);
      const expanded = coreServices.expandServiceSelection([...services], payload.selectedRoots, {
        allowMissingSelected: false,
      });
      if (expanded.missingIds.length > 0) throw new Error(FAILED);
      coreServices.writeServiceSelectionFile(options.infraDir, payload.selectedRoots);
      selectedRoots = payload.selectedRoots;
    } else {
      if (payload.selectedRoots) throw new Error(FAILED);
      const desired = coreServices.readDesiredSelection(options.infraDir, env);
      selectedRoots = desired.roots;
      allowMissingSelected = desired.source === "default";
    }
    const committed = await coreServices.commitConfigurationGeneration({
      infraDir: options.infraDir,
      services,
      integrationSchemas: authority?.integrationSchemas ?? options.integrationSchemas,
      input: { ...payload, selectedRoots },
      allowMissingSelected,
      revisionId: operation.revisionId,
      beforeCommit: options.beforeCommit,
      afterGenerationRename: options.afterGenerationRename,
      afterCommit: options.afterCommit,
    });
    return { revisionId: committed.revisionId, enabledServiceIds: committed.enabledServiceIds };
  } catch {
    throw new Error(FAILED);
  }
}

function trustedPayload(
  operation: TrustedConfigurationOperation,
  context: Parameters<OpsRuntime["stack.render"]>[1],
): TrustedConfigurationPayload {
  const snapshot = context.claim.capability.trustedConfiguration;
  if (
    context.claim.source !== "trusted-data" ||
    context.claim.capability.revisionId !== operation.revisionId ||
    !snapshot ||
    opsOperationFingerprint(context.claim.operation) !== opsOperationFingerprint(operation)
  ) {
    throw new Error(FAILED);
  }
  return snapshot as TrustedConfigurationPayload;
}

export function installTrustedConfigurationRuntime(
  runtime: OpsRuntime,
  options: TrustedConfigurationRuntimeOptions,
): void {
  runtime["stack.render"] = (operation, context) =>
    commitGeneration(options, operation, trustedPayload(operation, context), context.claim);
  runtime["serviceSelection.apply"] = (operation, context) =>
    commitGeneration(options, operation, trustedPayload(operation, context), context.claim);
  runtime["serviceConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceConfigs.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim);
  };
  runtime["integrationConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (
      !payload.integrationConfigs.some((entry) => entry.integrationId === operation.integrationId)
    ) {
      throw new Error(FAILED);
    }
    return commitGeneration(options, operation, payload, context.claim);
  };
  runtime["vault.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceSecrets.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim);
  };
  runtime["serviceSelection.inspect"] = async () => {
    try {
      return coreServices.readDesiredSelection(options.infraDir, options.env ?? process.env);
    } catch {
      throw new Error(FAILED);
    }
  };
}
