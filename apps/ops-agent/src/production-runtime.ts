import { existsSync } from "node:fs";
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
import {
  type CommunityRepositoryStore,
  installCommunityRepositoryRuntime,
} from "./community-repositories";
import {
  createDockerRuntime,
  type DockerRuntimeOptions,
  runContainedProcess,
} from "./docker-runtime";
import { createOwnedServiceResolver, type OwnedServiceResolver } from "./owned-services";
import { serviceActionForOperation } from "./policy";
import type { OpsExecutionContext, OpsRuntime } from "./runtime";
import { decideServiceAction, type ServiceAuthority } from "./service-action-policy";
import { resolveBootstrapEnabledServiceIds } from "./startup-authority";
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
}
const resolvers = new WeakMap<OpsRuntime, OwnedServiceResolver>();
const releaseAdapters = new WeakMap<OpsRuntime, AdministrativeReleaseEffects>();
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
    })),
  };
}

/** The production installer order; test seams are external I/O, never lifecycle handlers. */
export async function createProductionOpsRuntime(
  options: ProductionOpsRuntimeOptions,
): Promise<OpsRuntime> {
  const initial = await options.loadAuthority();
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
    ownedServices: owned,
  });
  installCommunityRepositoryRuntime(runtime, options.communityRepositories, owned);
  const runFixedCli = options.runFixedCli ?? createDefaultFixedCli(options.rootDir);
  const releaseEffects = createDefaultReleaseEffects(options.rootDir, runFixedCli);
  createTransitousLockRuntime(runtime, { rootDir: options.rootDir });
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
    const guarded = async (
      operation: Extract<OpsOperation, { serviceId: string }>,
      context: OpsExecutionContext,
    ) => {
      context.signal.throwIfAborted();
      const authority = serviceActionAuthority(
        await options.loadAuthority(),
        options.stack.infraDir,
      );
      const snapshot = (await owned.inspectOwnedServices(context.signal)).find(
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
      if (!decision.available || decision.execution !== "direct")
        throw new Error("Service action denied");
      return handler(operation, context);
    };
    // The finite loop preserves each handler's operation/result correspondence.
    Object.assign(runtime, { [kind]: guarded });
  }
  resolvers.set(runtime, owned);
  releaseAdapters.set(runtime, releaseEffects);
  return runtime;
}
