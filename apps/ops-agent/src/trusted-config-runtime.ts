import { readFileSync } from "node:fs";
import {
  type ConfigurationApplyResult,
  type OpsOperation,
  opsOperationFingerprint,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import type { OpsRuntime, OpsTrustedClaim } from "./runtime";

const FAILED = "Trusted configuration apply failed";
const PLAN_FAILED = "Configuration hardlink plan unavailable";
const PLAN_STALE = "Another configuration was applied before its hardlinks";
type TrustedConfigurationOperation = Exclude<
  Extract<OpsOperation, { revisionId: string }>,
  { kind: "configuration.hardlinks.inspect" }
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
  /**
   * Whether a container still mounts the checkout's Traefik dynamic
   * directory; `undefined` when Docker can't tell. Omitted, it is not known.
   */
  legacyTraefikDynamicMounted?: () => Promise<boolean | undefined>;
  /**
   * Every container's bind mounts; `undefined` when Docker can't tell. A
   * service-file tree one of them mounts is kept. Omitted, it is not known.
   */
  containerBindMounts?: () => Promise<coreServices.ContainerBindMounts[] | undefined>;
}

export interface TrustedConfigurationAuthoritySnapshot {
  revisionId: string;
  services: readonly coreServices.LoadedService[];
  integrationSchemas: ReadonlyMap<string, Record<string, unknown>>;
  /** Installed integrations left out of the schemas, and why. */
  integrationProblems?: readonly coreServices.IntegrationAuthorityProblem[];
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

const MAX_RECORDED_FAILURES = 32;

async function commitGeneration(
  options: TrustedConfigurationRuntimeOptions,
  operation: TrustedConfigurationOperation,
  payload: TrustedConfigurationPayload,
  claim: OpsTrustedClaim,
  signal: AbortSignal,
  failures: Map<string, string>,
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
        // The generation's containers run as the deployment's user, which
        // .env names; the agent reads it and refuses one without it.
        coreServices.assertRunningAsDeploymentUser(
          coreServices.readDeploymentUser(options.infraDir),
          "The operations agent",
        );
        // This generation mounts the agent's state from its own directory;
        // an earlier release's directories move there first.
        coreServices.prepareAgentStateDirectories(options.infraDir);
        // And its stores, which the generation mounts into app-api.
        coreServices.prepareAgentStores(options.infraDir);
        // A Traefik not recreated since an earlier release still reads its
        // routes from the checkout, where they are written too until none does.
        const legacyTraefik = await options.legacyTraefikDynamicMounted?.();
        const mounts = await options.containerBindMounts?.();
        const committed = await writer.commit({
          ...(mounts ? { containerBindMounts: mounts } : {}),
          services,
          integrationSchemas: authority?.integrationSchemas ?? options.integrationSchemas,
          input: { ...payload, selectedRoots },
          allowMissingSelected,
          revisionId: operation.revisionId,
          expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
          beforeCommit: options.beforeCommit,
          afterGenerationRename: options.afterGenerationRename,
          afterCommit: options.afterCommit,
          legacyTraefikDynamicMounted: legacyTraefik,
        });
        for (const problem of committed.stackFileProblems) process.stderr.write(`${problem}\n`);
        for (const line of committed.serviceFileReport) process.stderr.write(`${line}\n`);
        if (legacyTraefik === true) {
          process.stderr.write(`${coreServices.LEGACY_TRAEFIK_MOUNT_NOTICE}\n`);
        }
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
    const problem = operatorProblem(error);
    if (problem) {
      // The agent's log, and the admin panel through configuration.failure.inspect.
      process.stderr.write(`${problem}\n`);
      failures.set(operation.revisionId, problem);
      while (failures.size > MAX_RECORDED_FAILURES) {
        failures.delete(failures.keys().next().value as string);
      }
    }
    if (error instanceof coreServices.ConfigurationGenerationError) return error.result;
    return { outcome: "not_committed", reason: "failed", cleanupFailed: false };
  }
}

/**
 * The message of a failure the operator can fix (a service file or override,
 * a one-time step only a render on the host can do, or .env without the
 * deployment's user), or null.
 */
function operatorProblem(error: unknown): string | null {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof coreServices.ServiceFileError) return cause.message;
    if (cause instanceof coreServices.CheckoutRequiredError) return cause.message;
    if (cause instanceof coreServices.DeploymentUserError) return cause.message;
  }
  return null;
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
  // Why recent applies were not committed, when the operator can act on it.
  const failures = new Map<string, string>();
  runtime["configuration.failure.inspect"] = async (operation) => ({
    attemptedRevisionId: operation.attemptedRevisionId,
    problem: failures.get(operation.attemptedRevisionId)?.slice(0, 4_096) ?? null,
  });
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
      failures,
    );
  // The plan lives in the applied generation, which only this service can
  // read. Data-manager applies it: its mounts confine links and prunes to the
  // data root, where other containers can write.
  runtime["configuration.hardlinks.inspect"] = (operation, context) =>
    coreServices.withConfigurationGenerationWriter(
      options.infraDir,
      async () => {
        if (coreServices.currentConfigurationGeneration(options.infraDir) !== operation.revisionId)
          throw new Error(PLAN_STALE);
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
          if (!Array.isArray(plan)) throw new Error(PLAN_FAILED);
          return { revisionId: operation.revisionId, plan };
        } catch {
          throw new Error(PLAN_FAILED);
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
      failures,
    );
  runtime["serviceConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceConfigs.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim, context.signal, failures);
  };
  runtime["integrationConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (
      !payload.integrationConfigs.some((entry) => entry.integrationId === operation.integrationId)
    ) {
      throw new Error(FAILED);
    }
    return commitGeneration(options, operation, payload, context.claim, context.signal, failures);
  };
  runtime["vault.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceSecrets.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim, context.signal, failures);
  };
  runtime["serviceSelection.inspect"] = async () => {
    try {
      return coreServices.readDesiredSelection(options.infraDir, options.env ?? process.env);
    } catch {
      throw new Error(FAILED);
    }
  };
}
