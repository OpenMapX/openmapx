import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { type OpsOperation, SERVICE_ACTIONS, type ServiceActionDecision } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import {
  type AdministrativeReleaseEffects,
  createAdministrativeRuntime,
  createDefaultFixedCli,
  createDefaultReleaseEffects,
  type FixedCliRunner,
} from "./administrative-runtime";
import { readAgentHandoff } from "./agent-handoff";
import { installBackupPruneRuntime } from "./backup-prune-runtime";
import { installCatalogApprovalRuntime } from "./catalog-approval-runtime";
import { installCatalogValidationInputsRuntime } from "./catalog-validation-inputs";
import {
  type CommunityRepositoryStore,
  installCommunityRepositoryRuntime,
} from "./community-repositories";
import type { ConfigurationCandidateSource } from "./configuration-candidate-source";
import { inspectConfigurationHandoffPrerequisite } from "./configuration-handoff";
import { installConfigurationHardlinksRuntime } from "./configuration-hardlinks-runtime";
import { registerConfigurationMaintenanceSource } from "./configuration-maintenance-runtime";
import {
  assertOwnedMaintenanceRecreateRuntime,
  assertStagedCoordinatorReleaseWrite,
} from "./configuration-maintenance-store";
import { installCoreServiceRuntime } from "./core-service-runtime";
import {
  createDockerRuntime,
  type DockerRuntimeOptions,
  runContainedProcess,
} from "./docker-runtime";
import { installImageStageRuntime } from "./image-stage-runtime";
import { ServiceLifecycleExclusion } from "./lifecycle-exclusion";
import { createOwnedServiceResolver, type OwnedServiceResolver } from "./owned-services";
import { installPlatformConfigurationRuntime } from "./platform-configuration-runtime";
import { serviceActionForOperation } from "./policy";
import {
  type OpsExecutionContext,
  OpsExecutionFailure,
  OpsNotWiredError,
  type OpsRuntime,
} from "./runtime";
import { decideServiceAction, type ServiceAuthority } from "./service-action-policy";
import { installServiceLifecycleRuntime } from "./service-lifecycle-runtime";
import {
  assertAdmittedCoordinatorPullRuntime,
  installServicePullRuntime,
} from "./service-pull-runtime";
import { resolveBootstrapEnabledServiceIds } from "./startup-authority";
import { installTransitCredentialsRuntime } from "./transit-credentials-runtime";
import { createTransitousLockRuntime } from "./transitous-lock-runtime";
import {
  installTrustedConfigurationRuntime,
  readTrustedEnabledServiceIds,
  type TrustedConfigurationAuthoritySnapshot,
} from "./trusted-config-runtime";

export interface ProductionOpsRuntimeOptions {
  rootDir: string;
  stack: services.StackPaths;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
  communityRepositories: CommunityRepositoryStore;
  docker?: Pick<DockerRuntimeOptions, "execFile" | "followLogs" | "fileExists">;
  runFixedCli?: FixedCliRunner;
  candidateSource?: ConfigurationCandidateSource;
}
const resolvers = new WeakMap<OpsRuntime, OwnedServiceResolver>();
const releaseAdapters = new WeakMap<OpsRuntime, AdministrativeReleaseEffects>();

/** The legacy engine remains an internal building block for08.3. Production
 * never runs its mutation/recovery branches without that guarded installer. */
function installReleaseCapabilityBoundary(
  runtime: OpsRuntime,
  rootDir: string,
  infraDir: string,
  legacy: AdministrativeReleaseEffects,
  owned: OwnedServiceResolver,
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>,
): AdministrativeReleaseEffects {
  const directory = join(infraDir, ".ops-agent-releases");
  const assertLegacyRecoveryComplete = () => {
    try {
      lstatSync(join(directory, "transaction.json"));
      throw new OpsExecutionFailure("recovery_required", {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handoff = readAgentHandoff(rootDir);
    if (
      handoff &&
      !(handoff.consumed === true && ["applied", "rolled_back"].includes(handoff.phase))
    )
      throw new OpsExecutionFailure("recovery_required", {});
  };
  const withSource = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => {
    try {
      return await services.withConfigurationGenerationWriter(
        infraDir,
        async () => {
          const lock = await services.acquireReleaseStoreLock(directory);
          try {
            await assertStagedCoordinatorReleaseWrite(runtime, signal);
          } finally {
            lock.release();
          }
          return action();
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof services.ConfigurationGenerationError &&
        (error.cause instanceof OpsExecutionFailure ||
          error.cause instanceof services.ReleaseChannelDisabledError)
      )
        throw error.cause;
      throw error;
    }
  };
  runtime["release.clear"] = async (operation, context) =>
    withSource(context.signal, async () => {
      assertLegacyRecoveryComplete();
      context.signal.throwIfAborted();
      const result = await services.clearReleaseComposeSelection({
        path: join(infraDir, "docker-compose.release.yml"),
        expectedReleaseId: operation.releaseId,
      });
      if (!result.cleared) throw Error("Release selection changed");
      return { releaseId: operation.releaseId, cleared: true as const };
    });
  const unavailable = async (signal: AbortSignal): Promise<never> => {
    // The successful observation grants no continuation authority. No legacy
    // transaction, helper launch, backup or image pull follows this check.
    await withSource(signal, async () => undefined);
    throw new OpsNotWiredError();
  };
  return {
    ...legacy,
    initialize: async () => {
      // Inspection bypasses the legacy cached initializer, which may replay
      // fixed CLI under the release lock or mutate handoff evidence.
      await legacy.inspect();
      assertLegacyRecoveryComplete();
    },
    resolve: (context) => withSource(context.signal, () => legacy.resolve(context)),
    inspectSystem: async (context) => {
      const inspection = await legacy.inspectSystem(context);
      let maintenanceReady = false;
      if (inspection.dockerReachable && inspection.composeReady)
        try {
          assertLegacyRecoveryComplete();
          const containers = await owned.inspectOwnedServices(context.signal),
            agent = containers.find((row) => row.serviceId === "ops-agent"),
            coordinator = containers.find((row) => row.serviceId === "data-manager");
          if (agent?.state === "running" && coordinator?.state === "running") {
            await inspectConfigurationHandoffPrerequisite({
              rootDir,
              containerId: agent.containerId,
              imageId: agent.provenance.imageId,
              signal: context.signal,
              runDocker: async (args, io) =>
                (
                  await execFile("docker", args, {
                    signal: io.signal,
                    timeout: 15_000,
                    maxBuffer: 1024 * 1024,
                  })
                ).stdout,
            });
            maintenanceReady = true;
          }
        } catch {
          // Availability is a read-only observation. The actual candidate
          // repeats every prerequisite before acquiring or applying ownership.
        }
      return { ...inspection, maintenanceReady };
    },
    pull: (_releaseId, context) => unavailable(context.signal),
    apply: (_releaseId, _serviceIds, context) => unavailable(context.signal),
    updateAgent: (_request, context) => unavailable(context.signal),
  };
}
export function productionReleaseEffects(runtime: OpsRuntime): AdministrativeReleaseEffects {
  const effects = releaseAdapters.get(runtime);
  if (!effects) throw new Error("Production release adapter missing");
  return effects;
}
export function productionOwnedServices(runtime: OpsRuntime): OwnedServiceResolver {
  const resolver = resolvers.get(runtime);
  if (!resolver) throw new Error("Production ownership resolver missing");
  return resolver;
}

export function serviceActionAuthority(
  authority: TrustedConfigurationAuthoritySnapshot,
  infraDir: string,
): ServiceAuthority {
  return {
    revisionId: authority.revisionId,
    enabledServiceIds:
      readTrustedEnabledServiceIds(infraDir, authority.services) ??
      resolveBootstrapEnabledServiceIds(
        authority.services,
        services.readDesiredSelection(infraDir),
      ),
    services: authority.services.map((service) => ({
      serviceId: service.manifest.id,
      isBuiltIn: service.isBuiltIn,
      buildable: !!service.manifest.buildCommand,
      creationDependencies: services.serviceCreationDependencyIds(authority.services, [
        service.manifest.id,
      ]),
    })),
  };
}

/** The production installer order; test seams are external I/O, never lifecycle handlers. */
export async function createProductionOpsRuntime(
  options: ProductionOpsRuntimeOptions,
): Promise<OpsRuntime> {
  const initial = await options.loadAuthority();
  const lifecycle = new ServiceLifecycleExclusion(options.stack.infraDir);
  const owned = createOwnedServiceResolver({
    stack: options.stack,
    execFile: options.docker?.execFile ?? runContainedProcess,
    loadAuthority: options.loadAuthority,
  });
  const runtime = createDockerRuntime({
    stack: options.stack,
    fileExists: options.docker?.fileExists ?? existsSync,
    execFile: options.docker?.execFile,
    followLogs: options.docker?.followLogs,
    trafficDataRoot: join(options.stack.infraDir, "data"),
    ownedServices: owned,
  });
  installTrustedConfigurationRuntime(runtime, {
    services: initial.services,
    integrationSchemas: initial.integrationSchemas,
    loadAuthority: options.loadAuthority,
    infraDir: options.stack.infraDir,
    rootDir: options.rootDir,
    execFile: options.docker?.execFile ?? runContainedProcess,
    ownedServices: owned,
    candidateSource: options.candidateSource,
  });
  installCommunityRepositoryRuntime(runtime, options.communityRepositories, owned, lifecycle);
  installConfigurationHardlinksRuntime(runtime, { infraDir: options.stack.infraDir });
  registerConfigurationMaintenanceSource(runtime, {
    rootDir: options.rootDir,
    infraDir: options.stack.infraDir,
    candidateSource: options.candidateSource,
    stack: options.stack,
    execFile: options.docker?.execFile ?? runContainedProcess,
    loadAuthority: options.loadAuthority,
    ownedServices: owned,
  });
  const runFixedCli = options.runFixedCli ?? createDefaultFixedCli(options.rootDir);
  installServiceLifecycleRuntime(runtime, {
    rootDir: options.rootDir,
    infraDir: options.stack.infraDir,
    runFixedCli,
  });
  installCoreServiceRuntime(runtime, {
    infraDir: options.stack.infraDir,
    ownedServices: owned,
    loadAuthority: async () =>
      serviceActionAuthority(await options.loadAuthority(), options.stack.infraDir),
    execFile: options.docker?.execFile,
  });
  installServicePullRuntime(runtime, {
    infraDir: options.stack.infraDir,
    candidateSource: options.candidateSource,
    loadAuthority: options.loadAuthority,
    ownedServices: owned,
    execFile: options.docker?.execFile,
  });
  installImageStageRuntime(runtime, {
    infraDir: options.stack.infraDir,
    loadAuthority: options.loadAuthority,
    execFile: options.docker?.execFile,
  });
  installBackupPruneRuntime(runtime, {
    infraDir: options.stack.infraDir,
    token: options.candidateSource?.token,
  });
  const releaseEffects = installReleaseCapabilityBoundary(
    runtime,
    options.rootDir,
    options.stack.infraDir,
    createDefaultReleaseEffects(options.rootDir, runFixedCli),
    owned,
    options.docker?.execFile ?? runContainedProcess,
  );
  createTransitousLockRuntime(runtime, { rootDir: options.rootDir });
  installTransitCredentialsRuntime(runtime, {
    rootDir: options.rootDir,
    sourceToken: options.candidateSource?.token,
    stack: options.stack,
    ownedServices: owned,
    execFile: options.docker?.execFile,
  });
  installCatalogValidationInputsRuntime(runtime, {
    rootDir: options.rootDir,
    stack: options.stack,
    ownedServices: owned,
    execFile: options.docker?.execFile,
  });
  installCatalogApprovalRuntime(runtime, { rootDir: options.rootDir });
  installPlatformConfigurationRuntime(runtime, { infraDir: options.stack.infraDir });
  createAdministrativeRuntime(runtime, {
    rootDir: options.rootDir,
    runFixedCli,
    releaseEffects,
    loadBuildAuthority: async () => {
      const authority = await options.loadAuthority();
      const configured = serviceActionAuthority(authority, options.stack.infraDir);
      return authority.services.map((service) => ({
        serviceId: service.manifest.id,
        enabled: configured.enabledServiceIds.has(service.manifest.id),
        isBuiltIn: service.isBuiltIn,
        ...(service.manifest.buildCommand ? { buildCommand: service.manifest.buildCommand } : {}),
      }));
    },
  });
  // system.update's legacy handler performs backup/pull before apply. Refuse
  // that entire branch through the same actual source boundary before effects.
  runtime["system.update"] = async (_operation, context) => {
    await releaseEffects.apply(_operation.releaseId, ["app-api"], context);
    throw new OpsNotWiredError();
  };
  runtime["services.inspect"] = async (_operation, context) => {
    const authority = serviceActionAuthority(await options.loadAuthority(), options.stack.infraDir);
    const snapshots = await owned.inspectOwnedServices(context.signal);
    return {
      services: authority.services.map((service) => {
        const snapshot = snapshots.find((entry) => entry.serviceId === service.serviceId);
        const scoped = { ...authority, services: [service] };
        const actions = Object.fromEntries(
          SERVICE_ACTIONS.map((action) => [action, decideServiceAction(scoped, snapshot, action)]),
        ) as Record<(typeof SERVICE_ACTIONS)[number], ServiceActionDecision>;
        return { serviceId: service.serviceId, state: snapshot?.state ?? "stopped", actions };
      }),
    };
  };
  // Admission is not the final authorization boundary. Refresh selection and provenance at execution.
  for (const kind of [
    "service.start",
    "service.stop",
    "service.restart",
    "service.recreate",
    "service.recreateIsolated",
    "service.pull",
    "service.image.stage",
    "service.remove",
    "service.update",
    "service.build",
    "service.logs",
    "service.logs.follow",
  ] as const) {
    const action = serviceActionForOperation(kind);
    if (!action) throw new Error("Service action mapping missing");
    const handler = runtime[kind] as (
      operation: OpsOperation,
      context: OpsExecutionContext,
    ) => Promise<unknown>;
    const execute = async (
      operation: Extract<OpsOperation, { serviceId: string }>,
      context: OpsExecutionContext,
    ) => {
      context.signal.throwIfAborted();
      const authority = serviceActionAuthority(
        await options.loadAuthority(),
        options.stack.infraDir,
      );
      const frozen =
        operation.serviceId === "data-manager" &&
        (operation.kind === "service.recreate" || operation.kind === "service.recreateIsolated") &&
        operation.maintenanceId
          ? await assertOwnedMaintenanceRecreateRuntime(runtime, operation, context)
          : undefined;
      const snapshot = (frozen ?? (await owned.inspectOwnedServices(context.signal))).find(
        (s) => s.serviceId === operation.serviceId,
      );
      const encoded = context.claim.capability.values.ownedService;
      if (typeof encoded === "string") {
        const admitted = JSON.parse(encoded) as { containerId?: string; provenance?: unknown };
        if (
          !snapshot ||
          admitted.containerId !== snapshot.containerId ||
          JSON.stringify(admitted.provenance) !== JSON.stringify(snapshot.provenance)
        )
          throw new Error("Owned service claim changed");
      }
      const service = authority.services.find((s) => s.serviceId === operation.serviceId);
      const decision = decideServiceAction(
        { ...authority, services: service ? [service] : [] },
        snapshot,
        action,
      );
      if (
        decision.available &&
        decision.execution === "workflow" &&
        operation.serviceId === "data-manager" &&
        (operation.kind === "service.recreate" || operation.kind === "service.recreateIsolated")
      )
        await assertOwnedMaintenanceRecreateRuntime(runtime, operation, context);
      else if (
        !decision.available ||
        (decision.execution !== "direct" &&
          !(operation.kind === "service.image.stage" && decision.workflow === "image-stage"))
      ) {
        if (operation.kind === "service.pull" && operation.serviceId === "data-manager")
          await assertAdmittedCoordinatorPullRuntime(runtime, operation, context);
        else throw new Error("Service action denied");
      }
      return handler(operation, context);
    };
    const guarded = async (
      operation: Extract<OpsOperation, { serviceId: string }>,
      context: OpsExecutionContext,
    ) => {
      if (
        ![
          "service.start",
          "service.restart",
          "service.recreate",
          "service.recreateIsolated",
          "service.update",
        ].includes(kind)
      )
        return execute(operation, context);
      // Compose up may also create dependencies, including release-overlay
      // dependencies. Conservatively exclude every registered service for those
      // commands; this local boundary does not acquire or replace root authority.
      const ids =
        kind === "service.start" || kind === "service.recreate" || kind === "service.update"
          ? (await options.loadAuthority()).services.map((service) => service.manifest.id).sort()
          : [operation.serviceId];
      return lifecycle.creating(ids, context.signal, async (begin) => {
        if (kind === "service.start" || kind === "service.recreate" || kind === "service.update") {
          const current = (await options.loadAuthority()).services
            .map((service) => service.manifest.id)
            .sort();
          if (JSON.stringify(current) !== JSON.stringify(ids))
            throw new Error("Service authority changed while waiting");
        }
        return execute(operation, { ...context, beginServiceCreation: begin });
      });
    };
    // The finite loop preserves each handler's operation/result correspondence.
    Object.assign(runtime, { [kind]: guarded });
  }
  const stackStart = runtime["stack.start"];
  runtime["stack.start"] = async (operation, context) => {
    const ids = (await options.loadAuthority()).services
      .map((service) => service.manifest.id)
      .sort();
    return lifecycle.creating(ids, context.signal, async (begin) => {
      const authority = await options.loadAuthority();
      const current = authority.services.map((service) => service.manifest.id).sort();
      if (JSON.stringify(current) !== JSON.stringify(ids))
        throw new Error("Service authority changed while waiting");
      serviceActionAuthority(authority, options.stack.infraDir);
      return stackStart(operation, { ...context, beginServiceCreation: begin });
    });
  };
  resolvers.set(runtime, owned);
  releaseAdapters.set(runtime, releaseEffects);
  return runtime;
}
