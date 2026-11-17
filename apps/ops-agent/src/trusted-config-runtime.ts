import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  closeControlInstallation,
  observeConfigurationSources,
  openControlInstallation,
  verifyConfigurationSourceWitness,
} from "@openmapx/core/build-artifacts";
import {
  type ConfigurationApplyResult,
  type ConfigurationHardlinksPreview,
  canonicalJson,
  type OpsOperation,
  opsOperationFingerprint,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import type { ConfigurationReleaseSnapshot } from "../../../packages/core/src/build-artifacts/configuration-release-snapshot";
import { retainConfigurationGenerationNonCommit } from "../../../packages/core/src/build-artifacts/control-authority";
import { configurationGenerationNonCommitForError } from "../../../packages/core/src/services/configuration-generation";
import {
  type ConfigurationCandidateSource,
  discardConfigurationCandidate,
  readConfigurationCandidate,
  readConfigurationCandidateRecord,
  retainConfigurationCandidate,
} from "./configuration-candidate-source";
import { inspectConfigurationHandoffPrerequisite } from "./configuration-handoff";
import { assertConfigurationCoordinatorReady } from "./configuration-hardlinks-runtime";
import {
  assertStagedCoordinatorConfigurationWrite,
  inspectOwnedMaintenanceGenerationRuntime,
  readMaintenanceRelease,
  readPreparedMaintenanceRelease,
} from "./configuration-maintenance-store";
import {
  preflightConfigurationRelease,
  verifyFrozenConfigurationRelease,
} from "./configuration-release-preflight";
import { configurationPolicyRevision } from "./configured-resource-authority";
import { type DockerRuntimeOptions, runContainedProcess } from "./docker-runtime";
import type { OwnedServiceResolver } from "./owned-services";
import type { OpsExecutionContext, OpsRuntime, OpsTrustedClaim } from "./runtime";
import { OpsHostUpdateRequiredError } from "./runtime";
import { agentLogLine } from "./service-files-at-start";
import { renderCoordinatorCandidate } from "./service-pull-runtime";

const FAILED = "Trusted configuration apply failed";
const PLAN_FAILED = "Configuration hardlink plan unavailable";
const PLAN_STALE = "Another configuration was applied before its hardlinks";
type TrustedConfigurationOperation = Extract<
  OpsOperation,
  {
    kind:
      | "stack.render"
      | "serviceSelection.apply"
      | "serviceConfig.apply"
      | "integrationConfig.apply"
      | "vault.apply";
  }
>;

export interface TrustedConfigurationRuntimeOptions {
  services: readonly coreServices.LoadedService[];
  integrationSchemas: ReadonlyMap<string, Record<string, unknown>>;
  loadAuthority?: () => Promise<TrustedConfigurationAuthoritySnapshot>;
  infraDir: string;
  rootDir?: string;
  execFile?: NonNullable<DockerRuntimeOptions["execFile"]>;
  ownedServices?: OwnedServiceResolver;
  candidateSource?: ConfigurationCandidateSource;
  /** The process environment, read for the operator's selection override. */
  env?: NodeJS.ProcessEnv;
  beforeCommit?: () => Promise<void>;
  afterGenerationRename?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
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
  runtime: OpsRuntime,
  options: TrustedConfigurationRuntimeOptions,
  operation: TrustedConfigurationOperation,
  payload: TrustedConfigurationPayload,
  claim: OpsTrustedClaim,
  signal: AbortSignal,
  failures: Map<string, string>,
  executionContext?: OpsExecutionContext,
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
        if (!executionContext) throw Error("Actual configuration publication context required");
        await assertStagedCoordinatorConfigurationWrite(
          runtime,
          operation,
          executionContext,
          signal,
        );
        const authority = await options.loadAuthority?.();
        if (
          authority &&
          (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authority.revisionId) ||
            claim.capability.values.authorityRevision !==
              configurationPolicyRevision(authority.revisionId, options.env))
        ) {
          throw new Error(FAILED);
        }
        const services = authority?.services ?? options.services;
        const installation = openControlInstallation({
          infraDir: options.infraDir,
          role: "ops-agent",
          serviceIds: services.map((service) => service.manifest.id),
        });
        try {
          verifyConfigurationSourceWitness({
            installation,
            infraDir: options.infraDir,
            sourceRevision: operation.expectedSourceRevision,
            expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
            authorityRevision: authority?.revisionId ?? "registry-v1",
            env: options.env,
          });
        } finally {
          closeControlInstallation(installation);
        }
        const env = options.env ?? process.env;
        // Capture cleanup retention before selection effects under the same writer.
        const frozen =
          (operation.kind === "stack.render" || operation.kind === "vault.apply") &&
          operation.maintenanceId &&
          executionContext
            ? await inspectOwnedMaintenanceGenerationRuntime(
                runtime,
                executionContext,
                operation,
                signal,
              )
            : undefined;
        const inventory =
          frozen ??
          (options.ownedServices?.inspectInventory
            ? await options.ownedServices.inspectInventory(signal)
            : options.ownedServices
              ? {
                  services: await options.ownedServices.inspectOwnedServices(signal),
                  observedContainerIds: undefined,
                }
              : undefined);
        const ownedServiceGenerations = inventory?.services.map((snapshot) => ({
          containerId: snapshot.containerId,
          revisionIds: snapshot.provenance.composeConfigFiles
            .map((file) => basename(dirname(file)))
            .filter((id) => /^cfg1_[A-Za-z0-9_-]{43}$/.test(id)),
        }));
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
        // A release update's maintenance pins its frozen release in the generation it commits.
        let release: coreServices.ReleaseManifest | undefined;
        if (operation.kind === "stack.render" && operation.maintenanceId) {
          const reading = openControlInstallation({
            infraDir: options.infraDir,
            role: "ops-agent",
            serviceIds: services.map((service) => service.manifest.id),
          });
          try {
            const frozen = readMaintenanceRelease(reading, operation.maintenanceId);
            if (frozen)
              release = coreServices.parseReleaseManifest(
                frozen.canonicalManifest,
                frozen.imagePrefix,
              );
          } finally {
            closeControlInstallation(reading);
          }
        }
        const mounts = await options.containerBindMounts?.();
        const committed = await writer.commit({
          ...(release ? { release } : {}),
          ...(mounts ? { containerBindMounts: mounts } : {}),
          services,
          ownedServiceGenerations,
          observedServiceContainerIds: inventory?.observedContainerIds,
          integrationSchemas: authority?.integrationSchemas ?? options.integrationSchemas,
          input: { ...payload, selectedRoots },
          allowMissingSelected,
          revisionId: operation.revisionId,
          expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
          operationKey: executionContext?.execution.operationKey,
          beforeCommit: options.beforeCommit,
          afterGenerationRename: options.afterGenerationRename,
          afterCommit: options.afterCommit,
        });
        for (const problem of committed.stackFileProblems) process.stderr.write(`${problem}\n`);
        for (const line of committed.serviceFileReport) {
          process.stderr.write(`${agentLogLine(line)}\n`);
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
    const original = configurationGenerationNonCommitForError(error);
    if (original && executionContext?.controlAuthority)
      retainConfigurationGenerationNonCommit(executionContext.controlAuthority, original);
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
 * or .env without the deployment's user), or null.
 */
function operatorProblem(error: unknown): string | null {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof coreServices.ServiceFileError) return cause.message;
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
  runtime["configuration.sources.inspect"] = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const authority = await options.loadAuthority?.();
      const services = authority?.services ?? options.services;
      const installation = openControlInstallation({
        infraDir: options.infraDir,
        role: "ops-agent",
        serviceIds: services.map((service) => service.manifest.id),
      });
      try {
        const observed = observeConfigurationSources({
          installation,
          infraDir: options.infraDir,
          services,
          authorityRevision: authority?.revisionId ?? "registry-v1",
          env: options.env,
        });
        if ((await options.loadAuthority?.())?.revisionId !== authority?.revisionId) continue;
        return observed;
      } finally {
        closeControlInstallation(installation);
      }
    }
    throw Error("Host sources unavailable");
  };
  runtime["configuration.hardlinks.preview"] = async (operation, context) => {
    if (!options.candidateSource) throw Error("Configuration candidate source unavailable");
    const candidate = await readConfigurationCandidate(
      options.candidateSource,
      operation.candidateId,
    );
    const original = candidate.operation;
    if (
      !("expectedCurrentRevisionId" in original) ||
      !("coordinatorMode" in original) ||
      original.revisionId !== operation.revisionId ||
      original.expectedCurrentRevisionId !== operation.expectedCurrentRevisionId ||
      original.expectedSourceRevision !== operation.expectedSourceRevision ||
      original.coordinatorMode !== operation.coordinatorMode ||
      candidate.record.expectedSourceRevision !== operation.expectedSourceRevision
    )
      throw Error("Configuration preview identity conflict");
    await assertStagedCoordinatorConfigurationWrite(runtime, operation, context, context.signal);
    const authority = await options.loadAuthority?.();
    const services = authority?.services ?? options.services;
    const installation = openControlInstallation({
      infraDir: options.infraDir,
      role: "ops-agent",
      serviceIds: services.map((service) => service.manifest.id),
    });
    try {
      verifyConfigurationSourceWitness({
        installation,
        infraDir: options.infraDir,
        sourceRevision: operation.expectedSourceRevision,
        expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
        authorityRevision: authority?.revisionId ?? "registry-v1",
        env: options.env,
      });
    } finally {
      closeControlInstallation(installation);
    }
    const desired = coreServices.readDesiredSelection(options.infraDir, options.env ?? process.env);
    const rendered = coreServices.renderConfiguration({
      infraDir: options.infraDir,
      services,
      integrationSchemas: authority?.integrationSchemas ?? options.integrationSchemas,
      input: {
        ...candidate.payload,
        selectedRoots: candidate.payload.selectedRoots ?? desired.roots,
      },
      allowMissingSelected: !candidate.payload.selectedRoots && desired.source === "default",
    });
    const plan = rendered.rendered.hardlinkPlan;
    if (candidate.record.privateCoordinatorLifecycle)
      renderCoordinatorCandidate(
        candidate,
        authority ?? {
          revisionId: "registry-v1",
          services,
          integrationSchemas: options.integrationSchemas,
        },
        options.infraDir,
      );
    if (candidate.record.maintenanceId) {
      if (!options.ownedServices) throw Error("Actual maintenance ownership inventory unavailable");
      const originalContainers = await options.ownedServices.inspectOwnedServices(context.signal);
      if (
        candidate.record.privatePlatformIntent &&
        candidate.record.affectedServiceIds.some((id) =>
          ["postgis", "redis", "app-web", "app-api", "traefik", "ops-agent"].includes(id),
        )
      ) {
        const agent = originalContainers.find((value) => value.serviceId === "ops-agent");
        if (!options.rootDir || !options.execFile || !agent || agent.state !== "running")
          throw new OpsHostUpdateRequiredError();
        await inspectConfigurationHandoffPrerequisite({
          rootDir: options.rootDir,
          containerId: agent.containerId,
          imageId: agent.provenance.imageId,
          signal: context.signal,
          runDocker: async (args, command) =>
            (
              await options.execFile!("docker", args, {
                signal: command.signal,
                timeout: 15000,
                maxBuffer: 65536,
              })
            ).stdout,
        });
      }
      const releaseSelection = candidate.record.privatePlatformIntent?.release;
      // Once the maintenance holds its data fence the release is frozen and
      // already on the host, so this re-check never contacts the registry.
      let frozenRelease: ConfigurationReleaseSnapshot | undefined;
      if (releaseSelection) {
        const reading = openControlInstallation({
          infraDir: options.infraDir,
          role: "ops-agent",
          serviceIds: services.map((service) => service.manifest.id),
        });
        try {
          frozenRelease = readPreparedMaintenanceRelease(reading, candidate.record.maintenanceId);
        } finally {
          closeControlInstallation(reading);
        }
      }
      if (releaseSelection && frozenRelease)
        await verifyFrozenConfigurationRelease({
          selection: releaseSelection,
          frozen: frozenRelease,
          execFile: options.execFile ?? runContainedProcess,
          signal: context.signal,
        });
      else if (releaseSelection)
        await preflightConfigurationRelease({
          infraDir: options.infraDir,
          selection: releaseSelection,
          execFile: options.execFile ?? runContainedProcess,
          signal: context.signal,
        });
    }
    if (plan.length > 256) throw Error("Configuration preview budget exceeded");
    let coordinatorState: ConfigurationHardlinksPreview["coordinatorState"] = "not_required";
    if (
      plan.length ||
      candidate.record.privateCoordinatorLifecycle ||
      candidate.record.privatePlatformIntent
    ) {
      const dm = rendered.resolved.enabled.find(
        (service) => service.manifest.id === "data-manager",
      );
      if (!dm) coordinatorState = "disabled";
      else {
        try {
          const status = await runtime["stack.status"]({ kind: "stack.status" }, context);
          const dm = status.services.find((service) => service.serviceId === "data-manager");
          coordinatorState =
            dm?.state === "running" && (dm.health === "healthy" || dm.health === "none")
              ? "running"
              : "stopped";
          if (coordinatorState === "running")
            await assertConfigurationCoordinatorReady(context.signal);
        } catch {
          coordinatorState = "unavailable";
        }
      }
    }
    const requiredServiceIds = [...new Set(plan.map((entry) => entry.consumerService))].sort();
    return {
      entries: plan.length,
      requiredServiceIds,
      coordinatorState,
      previewDigest: createHash("sha256")
        .update("openmapx-configuration-hardlinks-preview-v1\0")
        .update(
          canonicalJson({
            candidateId: operation.candidateId,
            revisionId: operation.revisionId,
            expectedSourceRevision: operation.expectedSourceRevision,
            coordinatorMode: operation.coordinatorMode,
            plan,
          }),
        )
        .digest("hex"),
    };
  };
  const candidates = () => {
    if (!options.candidateSource) throw Error("Configuration candidate source unavailable");
    return options.candidateSource;
  };
  runtime["configuration.candidate.retain"] = async (operation) => {
    retainConfigurationCandidate(candidates(), operation.record);
    return { retained: true };
  };
  runtime["configuration.candidate.read"] = async (operation) => ({
    record: readConfigurationCandidateRecord(candidates(), operation.lookup),
  });
  runtime["configuration.candidate.discard"] = async (operation) => ({
    removed: await discardConfigurationCandidate(candidates(), operation.operationKey),
  });
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
      runtime,
      options,
      operation,
      trustedPayload(operation, context),
      context.claim,
      context.signal,
      failures,
      context,
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
      runtime,
      options,
      operation,
      trustedPayload(operation, context),
      context.claim,
      context.signal,
      failures,
      context,
    );
  runtime["serviceConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceConfigs.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(
      runtime,
      options,
      operation,
      payload,
      context.claim,
      context.signal,
      failures,
      context,
    );
  };
  runtime["integrationConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (
      !payload.integrationConfigs.some((entry) => entry.integrationId === operation.integrationId)
    ) {
      throw new Error(FAILED);
    }
    return commitGeneration(
      runtime,
      options,
      operation,
      payload,
      context.claim,
      context.signal,
      failures,
      context,
    );
  };
  runtime["vault.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceSecrets.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(
      runtime,
      options,
      operation,
      payload,
      context.claim,
      context.signal,
      failures,
      context,
    );
  };
  runtime["serviceSelection.inspect"] = async () => {
    try {
      return coreServices.readDesiredSelection(options.infraDir, options.env ?? process.env);
    } catch {
      throw new Error(FAILED);
    }
  };
}
