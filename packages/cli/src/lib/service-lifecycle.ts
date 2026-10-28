import type {
  BorrowedArtifactTargetLease,
  TargetLeaseAuthority,
} from "@openmapx/core/build-artifacts";
import { assertControlExecutionForward } from "@openmapx/core/build-artifacts";
import type { CoordinatorMode, ExecutionRef, ServicePreparationResult } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";

export type LifecycleOwnershipRequest = {
  execution: ExecutionRef;
  serviceIds: readonly string[];
  expectedConfigurationRevisionId?: string;
  inheritedLease?: BorrowedArtifactTargetLease;
  signal?: AbortSignal;
};
export type ServiceLifecycleEffects = {
  withOwnership<T>(
    request: LifecycleOwnershipRequest,
    run: (ownership: services.VerifiedLifecycleOwnership) => Promise<T>,
  ): Promise<T>;
  validatePins(ids: readonly string[]): Promise<void>;
  pull(ids: readonly string[], signal?: AbortSignal): Promise<void>;
  prepare(options: {
    ownership: services.VerifiedLifecycleOwnership;
    coordinatorMode: CoordinatorMode;
    signal?: AbortSignal;
  }): Promise<ServicePreparationResult>;
  recreate(ids: readonly string[], noDeps: boolean, signal?: AbortSignal): Promise<void>;
};
function forward(ownership: services.VerifiedLifecycleOwnership, signal?: AbortSignal) {
  signal?.throwIfAborted();
  assertControlExecutionForward(services.assertVerifiedLifecycleOwnership(ownership));
}
/** The supplied adapter owns the one writer and target lease; inner preparation never reacquires. */
export function prepareServiceLifecycle(
  request: LifecycleOwnershipRequest & { coordinatorMode: CoordinatorMode },
  effects: ServiceLifecycleEffects,
): Promise<ServicePreparationResult> {
  return effects.withOwnership(request, async (ownership) => {
    forward(ownership, request.signal);
    return effects.prepare({
      ownership,
      coordinatorMode: request.coordinatorMode,
      signal: request.signal,
    });
  });
}
export function runServiceUpdate(
  request: LifecycleOwnershipRequest & { noDeps?: boolean },
  effects: ServiceLifecycleEffects,
): Promise<{ changed: true; revisionId: string }> {
  return effects.withOwnership(request, async (ownership) => {
    forward(ownership, request.signal);
    await effects.validatePins(request.serviceIds);
    forward(ownership, request.signal);
    await effects.pull(request.serviceIds, request.signal);
    forward(ownership, request.signal);
    const prepared = await prepareServiceLifecycle(
      { ...request, coordinatorMode: "ensure-running" },
      effects,
    );
    forward(ownership, request.signal);
    await effects.recreate(request.serviceIds, request.noDeps ?? false, request.signal);
    return { changed: true, revisionId: prepared.revisionId };
  });
}

// The concrete CLI adapter is kept here so ordinary and delegated commands enter
// the same nominal writer/target/receipt scope.
export class ServiceLifecycleCommandError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}
export async function runCliServiceLifecycle(options: {
  action: "start" | "update";
  serviceIds: readonly string[];
  noDeps?: boolean;
  expectedConfigurationRevisionId?: string;
}): Promise<void> {
  if (options.action === "update" && options.serviceIds.includes("data-manager"))
    throw new ServiceLifecycleCommandError(
      1,
      "Coordinator Update requires its guarded administrative workflow",
    );
  const { randomBytes, randomUUID } = await import("node:crypto");
  const { existsSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const control = await import("@openmapx/core/build-artifacts");
  const ops = await import("@openmapx/core/ops");
  const { repoPaths } = await import("./paths");
  const { cliControlContext } = await import("./control-context");
  const { assertCliDeploymentSecrets } = await import("./deployment-secret-policy");
  const { renderComposeWithWriter } = await import("../commands/compose");
  const { dockerComposeStream, dockerCompose } = await import("./docker");
  const { readGeneratedHardlinkPlan } = await import("./hardlinks");
  const release = await import("./release");
  const paths = repoPaths();
  assertCliDeploymentSecrets();
  mkdirSync(join(paths.infraDir, "data"), { recursive: true });
  if (!existsSync("/run/secrets/openmapx-control-verifiers"))
    await control.provisionControlInstallation(paths.infraDir);
  const ids = [...new Set(options.serviceIds)].sort();
  const registry = new services.ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const targets = registry
    .list()
    .map((service) => service.manifest.id)
    .sort();
  if (!ids.length || ids.some((id) => !targets.includes(id)))
    throw Error("Unknown lifecycle target");
  if (
    !ids.includes("data-manager") &&
    services.serviceCreationDependencyIds(registry.list(), ids).includes("data-manager")
  )
    throw new ServiceLifecycleCommandError(
      1,
      "Coordinator maintenance required before service creation",
    );
  const assertNativeCreation = async () => {
    if (ids.includes("data-manager") || (options.action === "update" && options.noDeps)) return;
    const rendered = await dockerCompose(["config", "--format", "json"]);
    if (rendered.exitCode !== 0)
      throw new ServiceLifecycleCommandError(1, "Service creation dependencies unavailable");
    let dependencies: string[];
    try {
      dependencies = services.composeCreationDependencyIds(JSON.parse(rendered.stdout), ids);
    } catch {
      throw new ServiceLifecycleCommandError(1, "Service creation dependencies unavailable");
    }
    if (dependencies.includes("data-manager"))
      throw new ServiceLifecycleCommandError(
        1,
        "Coordinator maintenance required before service creation",
      );
  };
  const inherited = cliControlContext();
  const seed = inherited
    ? await services.withServiceLifecycleReceiptAuthority(inherited.authority, () =>
        services.readServiceLifecycleReceipt({
          dataRoot: join(paths.infraDir, "data"),
          execution: inherited.authority.execution,
        }),
      )
    : undefined;
  const expected =
    options.expectedConfigurationRevisionId ??
    seed?.expectedRevisionId ??
    (await services.withConfigurationGenerationWriter(paths.infraDir, async () =>
      services.currentConfigurationGeneration(paths.infraDir),
    ));
  if (!expected) throw Error("An initial configuration generation is required");
  // The existing generation supplies the exact finite hardlink intent. A nonempty
  // plan must use its retained durable leaf; it can never fall back to /link/local.
  const plan = readGeneratedHardlinkPlan().plan;
  const operation =
    options.action === "update"
      ? {
          kind: "service.update" as const,
          serviceId: ids[0]!,
          expectedConfigurationRevisionId: expected,
          ...(options.noDeps ? { noDeps: true } : {}),
        }
      : {
          kind: "service.start" as const,
          serviceId: ids[0]!,
          expectedConfigurationRevisionId: expected,
        };
  const installation =
    inherited?.installation ??
    control.openControlInstallation({
      infraDir: paths.infraDir,
      role: "host-cli",
      serviceIds: targets,
    });
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + ops.opsExecutionBudget(operation.kind).processMs;
  const operationFingerprint = ops.opsOperationFingerprint(operation);
  const execution = inherited?.authority.execution ?? {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: randomUUID(),
    operationKey: ops.createControlRootOperationKey({
      notAfter: deadlineAt,
      nonce: randomBytes(16),
    }),
    operationFingerprint,
    deadlineAt,
    fingerprint: ops.executionFingerprint({
      kind: operation.kind,
      operationFingerprint,
      deadlineAt,
    }),
  };
  const finalRevisionId = inherited
    ? control.ownedServiceLifecycleFinalRevisionId(inherited.authority)
    : control.serviceLifecycleFinalRevisionId(execution.operationKey);
  const frozenPlan = { plan, prune: true as const };
  const reservation = control.lifecycleHardlinkReservation({
    parent: execution,
    revisionId: finalRevisionId,
    plan: frozenPlan,
    serviceIds: targets,
  });
  const authority =
    inherited?.authority ??
    control.retainAdmittedControlExecution(installation, {
      execution,
      operation,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: targets,
      reservations: reservation ? [reservation] : [],
    });
  control.retainGenerationHardlinksOwnerPlan(authority, {
    version: 1,
    parent: execution,
    revisionId: finalRevisionId,
    coordinatorMode: "ensure-running",
    plan: frozenPlan,
    reservation,
  });
  if (inherited && !inherited.lease)
    throw Error("Delegated lifecycle requires its original borrowed lease");
  let ownership: services.VerifiedLifecycleOwnership | undefined;
  let store: services.ServiceLifecycleReceiptStore | undefined;
  let receipt: services.ServiceLifecycleReceipt | undefined;
  let lease: TargetLeaseAuthority | undefined;
  const checkpoint = async (patch: Partial<services.ServiceLifecycleReceipt>) => {
    if (!store || !receipt || !ownership) throw Error("Lifecycle receipt owner unavailable");
    const next = { ...receipt, ...patch, sequence: receipt.sequence + 1 };
    await store.checkpoint(receipt.sequence, next, ownership);
    receipt = next;
  };
  const request: LifecycleOwnershipRequest = {
    execution,
    serviceIds: ids,
    expectedConfigurationRevisionId: expected,
    ...(inherited?.lease ? { inheritedLease: inherited.lease } : {}),
  };
  const effects: ServiceLifecycleEffects = {
    async withOwnership(inner, run) {
      if (ownership) {
        forward(ownership, inner.signal);
        if (
          ops.canonicalJson(inner.execution) !== ops.canonicalJson(execution) ||
          inner.serviceIds.some((id) => !ids.includes(id))
        )
          throw Error("Lifecycle ownership cannot expand");
        return run(ownership);
      }
      lease =
        inherited?.lease ??
        (await control.acquireArtifactTargetLease({
          dataRoot: join(paths.infraDir, "data"),
          owner: authority,
          serviceIds: targets,
          signal: inner.signal,
        }));
      return services.withConfigurationGenerationWriter(
        paths.infraDir,
        (writer) =>
          services.withVerifiedLifecycleOwnership(
            { writer, lease: lease!, authority },
            async (verified) => {
              ownership = verified;
              const current = services.currentConfigurationGeneration(paths.infraDir);
              if (current !== expected) throw Error("Lifecycle configuration revision conflict");
              const directory = join(paths.infraDir, ".ops-agent-releases");
              mkdirSync(directory, { mode: 0o700, recursive: true });
              const lock = await services.acquireReleaseStoreLock(
                directory,
                {},
                { failIfBusy: true },
              );
              try {
                store = await services.openServiceLifecycleReceipt({
                  dataRoot: join(paths.infraDir, "data"),
                  execution,
                  serviceIds: ids,
                  action: options.action,
                  noDeps: options.noDeps ?? false,
                  coordinatorMode: "ensure-running",
                  expectedRevisionId: expected,
                  seedRevisionId: seed?.seedRevisionId ?? null,
                });
                receipt = await store.read();
                if (receipt.phase !== "prepared")
                  throw Error("Retained lifecycle can only be observed");
                try {
                  const result = await run(verified);
                  await checkpoint({ phase: "complete", followUp: "complete" });
                  return result;
                } catch (error) {
                  const committed = services.configurationGenerationWriterCommit(writer);
                  try {
                    await checkpoint({
                      phase: committed && !receipt!.finalRevisionId ? "unknown" : "failed",
                      ...(committed
                        ? { commit: "final_committed", finalRevisionId: committed.revisionId }
                        : {}),
                      followUp: committed
                        ? "unknown"
                        : receipt!.finalRevisionId
                          ? "failed"
                          : "not_started",
                      failure: {
                        reason:
                          receipt!.phase === "prepared"
                            ? "pins"
                            : receipt!.phase === "pins_validated"
                              ? "pull"
                              : receipt!.phase === "pulled"
                                ? "receipt_io"
                                : receipt!.phase === "generation_committed"
                                  ? "hardlinks"
                                  : "recreate",
                        failedServiceIds: ids,
                      },
                    });
                  } catch {
                    /* An unflushed receipt remains unknown; no competing pointer substitutes for it. */
                  }
                  throw error;
                }
              } finally {
                lock.release();
                ownership = undefined;
              }
            },
          ),
        inner.signal,
      );
    },
    async validatePins(selected) {
      if (release.touchesReleasePinnedServices(selected)) {
        const overlay = await release.ensureReleaseOverlay();
        if (overlay.status === "unpinned")
          throw new ServiceLifecycleCommandError(1, "Release selection unavailable");
      }
      await assertNativeCreation();
      await checkpoint({ phase: "pins_validated" });
    },
    async pull(selected) {
      const code = await dockerComposeStream(["pull", ...selected]);
      if (code !== 0)
        throw new ServiceLifecycleCommandError(
          code,
          "Image pull failed; refusing to recreate services",
        );
      await checkpoint({ phase: "pulled" });
    },
    async prepare({ ownership: owned, coordinatorMode }) {
      const rendered = await renderComposeWithWriter(
        {
          domain: process.env.DOMAIN ?? "localhost",
          expectedCurrentRevisionId: expected,
          revisionId: finalRevisionId,
        },
        owned.writer,
      );
      await checkpoint({
        phase: "generation_committed",
        finalRevisionId: rendered.revisionId,
        commit: "final_committed",
      });
      if (ops.canonicalJson(readGeneratedHardlinkPlan().plan) !== ops.canonicalJson(plan))
        throw Error("Hardlink intent changed");
      const sdk = await import("@openmapx/core/data-manager-sdk"),
        { dataManagerUrl } = await import("./data-manager-url");
      const transport = sdk.createDataManagerTransport({
        baseUrl: dataManagerUrl(),
        authToken: process.env.DATA_MANAGER_AUTH_TOKEN?.trim(),
        requestTimeoutMs: 15000,
        maxJsonBytes: 65536,
      });
      if (plan.length) {
        const ready = async () => {
          try {
            return sdk.unwrapDataManagerResponse(await sdk.getStatus({ transport })).ok;
          } catch {
            return false;
          }
        };
        if (!(await ready())) {
          if (coordinatorMode !== "ensure-running")
            throw Error("Configuration coordinator unavailable");
          const code = await dockerComposeStream(["up", "-d", "--no-recreate", "data-manager"]);
          if (code !== 0)
            throw new ServiceLifecycleCommandError(code, "Configuration coordinator Start failed");
          const until = Math.min(Date.now() + 30000, execution.deadlineAt);
          while (!(await ready())) {
            if (Date.now() >= until) throw Error("Configuration coordinator unavailable");
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      const hardlinks = await control.executeOwnedGenerationHardlinks({
        authority,
        lease: owned.lease,
        infraDir: paths.infraDir,
        transport,
      });
      await checkpoint({ phase: "hardlinks_applied", hardlinks });
      return { revisionId: rendered.revisionId, coordinatorMode, hardlinks };
    },
    async recreate(selected, noDeps) {
      if (services.currentConfigurationGeneration(paths.infraDir) !== receipt?.finalRevisionId)
        throw Error("Lifecycle generation changed before recreation");
      await assertNativeCreation();
      const code = await dockerComposeStream([
        "up",
        "-d",
        "--force-recreate",
        ...(noDeps ? ["--no-deps"] : []),
        ...selected,
      ]);
      if (code !== 0) throw new ServiceLifecycleCommandError(code, "Service recreation failed");
      await checkpoint({ phase: "recreated", followUp: "complete" });
    },
  };
  try {
    await effects.withOwnership(request, async () => {
      if (options.action === "update")
        await runServiceUpdate({ ...request, noDeps: options.noDeps }, effects);
      else {
        await effects.validatePins(ids);
        await prepareServiceLifecycle({ ...request, coordinatorMode: "ensure-running" }, effects);
        if (services.currentConfigurationGeneration(paths.infraDir) !== receipt?.finalRevisionId)
          throw Error("Lifecycle generation changed before Start");
        await assertNativeCreation();
        const code = await dockerComposeStream([
          "up",
          "-d",
          ...(ids.includes("data-manager") ? ["--no-recreate"] : []),
          ...ids,
        ]);
        if (code !== 0) throw new ServiceLifecycleCommandError(code, "Service Start failed");
        await checkpoint({ phase: "recreated", followUp: "complete" });
      }
    });
    if (!inherited && lease?.mode === "owner") {
      const verified = await services.withServiceLifecycleReceiptAuthority(authority, () =>
        services.readServiceLifecycleReceipt({ dataRoot: join(paths.infraDir, "data"), execution }),
      );
      if (verified.phase !== "complete" || !verified.finalRevisionId)
        throw Error("Exact completed lifecycle receipt required");
      control.retainControlEffectReceipt(authority, {
        outcome: "committed",
        publication: "committed",
        receipt: {
          kind: "ops-result",
          result:
            options.action === "update"
              ? { changed: true, revisionId: verified.finalRevisionId }
              : { changed: true },
        },
      });
      await control.settleArtifactTargetLeaseChild(
        lease,
        control.verifyControlEffectSettlement(installation, execution),
      );
      await control.releaseArtifactTargetLease(lease);
      lease = undefined;
    }
  } catch (error) {
    let cause = error;
    while (cause instanceof services.ConfigurationGenerationError && cause.cause instanceof Error)
      cause = cause.cause;
    throw cause;
  } finally {
    if (!inherited) {
      if (lease) control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(installation);
    }
  }
}
