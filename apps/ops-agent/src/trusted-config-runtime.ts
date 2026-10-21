import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConfigurationApplyResult,
  type OpsOperation,
  opsOperationFingerprint,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { applyHardlinkPlan, type HardlinkEntry } from "@openmapx/hardlinks";
import type { OpsRuntime, OpsTrustedClaim } from "./runtime";

const FAILED = "Trusted configuration apply failed";
const LINK_FAILED = "Configuration hardlinks could not be applied";
const LINK_STALE = "Another configuration was applied before its hardlinks";
type TrustedConfigurationOperation = Exclude<
  Extract<OpsOperation, { revisionId: string }>,
  { kind: "stack.link" }
>;

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
  signal: AbortSignal,
): Promise<ConfigurationApplyResult> {
  try {
    return await coreServices.withConfigurationGenerationWriter(
      options.infraDir,
      async (writer) => {
        signal.throwIfAborted();
        // Observe and compare before any desired-selection side effect, under
        // the same cross-process fence as CLI preparation and activation.
        const currentRevisionId = coreServices.currentConfigurationGeneration(options.infraDir);
        if (operation.expectedCurrentRevisionId !== currentRevisionId)
          throw new coreServices.ConfigurationGenerationError({
            outcome: "not_committed",
            reason: "conflict",
            currentRevisionId,
            cleanupFailed: false,
          });
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
          const expanded = coreServices.expandServiceSelection(
            [...services],
            payload.selectedRoots,
            {
              allowMissingSelected: false,
            },
          );
          if (expanded.missingIds.length > 0) throw new Error(FAILED);
          coreServices.writeServiceSelectionFile(options.infraDir, payload.selectedRoots);
          selectedRoots = payload.selectedRoots;
        } else {
          if (payload.selectedRoots) throw new Error(FAILED);
          const desired = coreServices.readDesiredSelection(options.infraDir, env);
          selectedRoots = desired.roots;
          allowMissingSelected = desired.source === "default";
        }
        const committed = await writer.commit({
          services,
          integrationSchemas: authority?.integrationSchemas ?? options.integrationSchemas,
          input: { ...payload, selectedRoots },
          allowMissingSelected,
          revisionId: operation.revisionId,
          expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
          beforeCommit: options.beforeCommit,
          afterGenerationRename: options.afterGenerationRename,
          afterCommit: options.afterCommit,
        });
        return {
          outcome: "committed",
          revisionId: committed.revisionId,
          enabledServiceIds: committed.enabledServiceIds,
          followUp: "complete",
          cleanupFailed: false,
        };
      },
      signal,
    );
  } catch (error) {
    if (error instanceof coreServices.ConfigurationGenerationError) return error.result;
    return { outcome: "not_committed", reason: "failed", cleanupFailed: false };
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
    context.claim.fingerprint !== opsOperationFingerprint(operation) ||
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
  runtime["configuration.inspect"] = (_operation, context) =>
    coreServices.withConfigurationGenerationWriter(
      options.infraDir,
      async () => coreServices.inspectAppliedConfiguration(options.infraDir),
      context.signal,
    );
  runtime["stack.render"] = (operation, context) =>
    commitGeneration(
      options,
      operation,
      trustedPayload(operation, context),
      context.claim,
      context.signal,
    );
  // The plan lives in the applied generation, which only this service can
  // read. Consumers run as the same host user, so linking here matches what
  // data-manager's link route would do.
  runtime["stack.link"] = (operation, context) =>
    coreServices.withConfigurationGenerationWriter(
      options.infraDir,
      async () => {
        if (coreServices.currentConfigurationGeneration(options.infraDir) !== operation.revisionId)
          throw new Error(LINK_STALE);
        try {
          const plan = JSON.parse(
            readFileSync(
              coreServices.currentConfigurationFile(
                options.infraDir,
                coreServices.GENERATED_HARDLINK_PLAN_FILE,
              ),
              "utf8",
            ),
          ) as unknown;
          if (!Array.isArray(plan)) throw new Error(LINK_FAILED);
          const result = applyHardlinkPlan(plan as HardlinkEntry[], {
            rootDir: join(options.infraDir, "data"),
            prune: true,
          });
          return { revisionId: operation.revisionId, entries: plan.length, ...result };
        } catch {
          throw new Error(LINK_FAILED);
        }
      },
      context.signal,
    );
  runtime["serviceSelection.apply"] = (operation, context) =>
    commitGeneration(
      options,
      operation,
      trustedPayload(operation, context),
      context.claim,
      context.signal,
    );
  runtime["serviceConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceConfigs.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim, context.signal);
  };
  runtime["integrationConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (
      !payload.integrationConfigs.some((entry) => entry.integrationId === operation.integrationId)
    ) {
      throw new Error(FAILED);
    }
    return commitGeneration(options, operation, payload, context.claim, context.signal);
  };
  runtime["vault.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceSecrets.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim, context.signal);
  };
  runtime["serviceSelection.inspect"] = async () => {
    try {
      return coreServices.readDesiredSelection(options.infraDir, options.env ?? process.env);
    } catch {
      throw new Error(FAILED);
    }
  };
}
