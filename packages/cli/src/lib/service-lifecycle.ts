import type {
  BorrowedArtifactTargetLease,
  TargetLeaseAuthority,
} from "@openmapx/core/build-artifacts";
import {
  assertArtifactTargetLeaseForward,
  assertControlExecutionForward,
} from "@openmapx/core/build-artifacts";
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
  withOwnership<T>(request: LifecycleOwnershipRequest, run: () => Promise<T>): Promise<T>;
  assertForward(signal?: AbortSignal): void;
  validatePins(ids: readonly string[], signal?: AbortSignal): Promise<void>;
  pull(ids: readonly string[], signal?: AbortSignal): Promise<void>;
  prepare(options: {
    coordinatorMode: CoordinatorMode;
    signal?: AbortSignal;
  }): Promise<ServicePreparationResult>;
  recreate(ids: readonly string[], noDeps: boolean, signal?: AbortSignal): Promise<void>;
};
/** The adapter holds the target lease throughout and the writer only inside each of its steps. */
export function prepareServiceLifecycle(
  request: LifecycleOwnershipRequest & { coordinatorMode: CoordinatorMode },
  effects: ServiceLifecycleEffects,
): Promise<ServicePreparationResult> {
  return effects.withOwnership(request, async () => {
    effects.assertForward(request.signal);
    return effects.prepare({
      coordinatorMode: request.coordinatorMode,
      signal: request.signal,
    });
  });
}
export function runServiceUpdate(
  request: LifecycleOwnershipRequest & { noDeps?: boolean },
  effects: ServiceLifecycleEffects,
): Promise<{ changed: true; revisionId: string }> {
  return effects.withOwnership(request, async () => {
    effects.assertForward(request.signal);
    await effects.validatePins(request.serviceIds, request.signal);
    effects.assertForward(request.signal);
    await effects.pull(request.serviceIds, request.signal);
    effects.assertForward(request.signal);
    const prepared = await prepareServiceLifecycle(
      { ...request, coordinatorMode: "ensure-running" },
      effects,
    );
    effects.assertForward(request.signal);
    await effects.recreate(request.serviceIds, request.noDeps ?? false, request.signal);
    return { changed: true, revisionId: prepared.revisionId };
  });
}

// The concrete CLI adapter is kept here so ordinary and delegated commands enter
// the same nominal writer/target/receipt scope. Containers started by these Docker
// effects take the configuration writer themselves, so it is never held across one.
export class ServiceLifecycleCommandError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}
/** The configuration moved under this lifecycle: a conflict, whatever phase it stopped in. */
class LifecycleConfigurationConflict extends Error {}
export async function runCliServiceLifecycle(options: {
  action: "start" | "update";
  serviceIds: readonly string[];
  noDeps?: boolean;
  expectedConfigurationRevisionId?: string;
}): Promise<void> {
  if (options.action === "update" && options.serviceIds.includes("data-manager"))
    throw new ServiceLifecycleCommandError(
      1,
      "Coordinator Update requires its guarded administrative workflow: use System → Updates or authenticated `pnpm openmapx system update` after `compose release --check`",
    );
  const { randomBytes, randomUUID } = await import("node:crypto");
  const { existsSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const control = await import("@openmapx/core/build-artifacts");
  const ops = await import("@openmapx/core/ops");
  const { log } = await import("./output");
  const { repoPaths } = await import("./paths");
  const { cliControlContext, collectHostControlRetention } = await import("./control-context");
  const { assertCliDeploymentSecrets } = await import("./deployment-secret-policy");
  const { renderComposeWithWriter } = await import("../commands/compose");
  const { dockerComposeStream, dockerCompose } = await import("./docker");
  const { readGeneratedHardlinkPlan } = await import("./hardlinks");
  const release = await import("./release");
  const { refuseAgentSwitchOrExit } = await import("./agent-layout");
  const { API_SERVICE_ID, migrateBeforeApiUpdate } = await import("./api-migrations");
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
  if (!inherited) await collectHostControlRetention(installation);
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
  let owning = false;
  let releaseStoreLock: services.ReleaseStoreLock | undefined;
  let store: services.ServiceLifecycleReceiptStore | undefined;
  let receipt: services.ServiceLifecycleReceipt | undefined;
  let lease: TargetLeaseAuthority | undefined;
  let finalCommit: ReturnType<typeof services.configurationGenerationWriterCommit>;
  let failureAttempted = false;
  let releaseSelection: string | null | undefined;
  let dockerEffectReached = false;
  const checkpoint = async (
    owned: services.VerifiedLifecycleOwnership,
    patch: Partial<services.ServiceLifecycleReceipt>,
  ) => {
    if (!store || !receipt) throw Error("Lifecycle receipt owner unavailable");
    const next = { ...receipt, ...patch, sequence: receipt.sequence + 1 };
    await store.checkpoint(receipt.sequence, next, owned);
    receipt = next;
  };
  const assertForward = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!lease) throw Error("Lifecycle target lease unavailable");
    assertControlExecutionForward(authority);
    assertArtifactTargetLeaseForward(lease);
  };
  const failureEvidence = (
    last: services.ServiceLifecycleReceipt,
    committed: typeof finalCommit,
    error: unknown,
  ): Partial<services.ServiceLifecycleReceipt> => ({
    phase: committed && !last.finalRevisionId ? "unknown" : "failed",
    ...(committed ? { commit: "final_committed", finalRevisionId: committed.revisionId } : {}),
    followUp: committed ? "unknown" : last.finalRevisionId ? "failed" : "not_started",
    failure: {
      reason:
        error instanceof LifecycleConfigurationConflict
          ? "revision_conflict"
          : last.phase === "prepared"
            ? "pins"
            : last.phase === "pins_validated"
              ? "pull"
              : last.phase === "pulled"
                ? "receipt_io"
                : last.phase === "generation_committed"
                  ? "hardlinks"
                  : "recreate",
      failedServiceIds: ids,
    },
  });
  // The caller rethrows the original failure. An unflushed receipt remains unknown;
  // no competing pointer substitutes for it, and the target fence stays in place.
  const warnFailureNotRecorded = () =>
    log.warn("The lifecycle failure was not recorded; its targets stay fenced until reconciled.");
  // The receipt only accepts a newly recorded final revision from the writer that
  // committed it, so a step that commits and then fails records its failure itself.
  const recordFailure = async (owned: services.VerifiedLifecycleOwnership, error: unknown) => {
    if (failureAttempted || !receipt) return;
    failureAttempted = true;
    const committed = services.configurationGenerationWriterCommit(owned.writer) ?? finalCommit;
    try {
      await checkpoint(owned, failureEvidence(receipt, committed, error));
    } catch {
      warnFailureNotRecorded();
    }
  };
  // Runs outside every step. Cancellation or expiry can have ended forward ownership,
  // so this takes a fresh writer and records through the receipt-only entry.
  const recordContainedFailure = async (error: unknown) => {
    if (failureAttempted || !store || !receipt || !lease) return;
    failureAttempted = true;
    const opened = store,
      last = receipt,
      held = lease;
    try {
      await services.withConfigurationGenerationWriter(paths.infraDir, async (writer) => {
        const next = {
          ...last,
          ...failureEvidence(last, finalCommit, error),
          sequence: last.sequence + 1,
        };
        await opened.recordContainment(last.sequence, next, { writer, lease: held, authority });
        receipt = next;
      });
    } catch {
      warnFailureNotRecorded();
    }
  };
  /** Holds the writer and release-store lock only for `run`, which must not start a container. */
  const withWriterStep = async <T>(
    run: (owned: services.VerifiedLifecycleOwnership) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const held = lease;
    if (!held) throw Error("Lifecycle target lease unavailable");
    return services.withConfigurationGenerationWriter(
      paths.infraDir,
      (writer) =>
        services.withVerifiedLifecycleOwnership(
          { writer, lease: held, authority },
          async (owned) => {
            assertForward(signal);
            const releasePaths = services.releaseStatePaths(paths.infraDir);
            services.ensureReleaseStateDirectory(releasePaths.directory);
            services.ensureReleaseStateDirectory(releasePaths.store);
            // A brief holder such as release selection must not fail a lifecycle whose
            // containers may already be running, so later steps wait for the store.
            const lock = await services.acquireReleaseStoreLock(
              releasePaths.store,
              {},
              { failIfBusy: !dockerEffectReached },
            );
            releaseStoreLock = lock;
            try {
              return await run(owned);
            } catch (error) {
              await recordFailure(owned, error);
              throw error;
            } finally {
              finalCommit =
                services.configurationGenerationWriterCommit(owned.writer) ?? finalCommit;
              releaseStoreLock = undefined;
              lock.release();
            }
          },
        ),
      signal,
    );
  };
  const readReleaseSelection = () =>
    services.readReleaseOverlayFile(services.releaseStatePaths(paths.infraDir).overlay);
  // Selecting a release rewrites the overlay without moving the generation.
  const assertConfigurationUnchanged = (revisionId: string, conflict: string) => {
    if (services.currentConfigurationGeneration(paths.infraDir) !== revisionId)
      throw new LifecycleConfigurationConflict(conflict);
    if (releaseSelection !== undefined && readReleaseSelection() !== releaseSelection)
      throw new LifecycleConfigurationConflict("Lifecycle release selection changed");
  };
  /**
   * Refuses the Docker effect that follows unless the configuration is still the
   * one this lifecycle expects. Releasing the writer leaves a short window before
   * Compose resolves the current generation; the writer step after the effect
   * re-checks both and fails the lifecycle if anything moved inside it.
   */
  const beforeDockerEffect = async (revisionId: string, conflict: string, signal?: AbortSignal) => {
    await withWriterStep(async () => assertConfigurationUnchanged(revisionId, conflict), signal);
    assertForward(signal);
    dockerEffectReached = true;
  };
  const committedRevisionId = () => {
    if (!receipt?.finalRevisionId) throw Error("Lifecycle generation is not committed");
    return receipt.finalRevisionId;
  };
  const request: LifecycleOwnershipRequest = {
    execution,
    serviceIds: ids,
    expectedConfigurationRevisionId: expected,
    ...(inherited?.lease ? { inheritedLease: inherited.lease } : {}),
  };
  const effects: ServiceLifecycleEffects = {
    assertForward,
    async withOwnership(inner, run) {
      if (owning) {
        assertForward(inner.signal);
        if (
          ops.canonicalJson(inner.execution) !== ops.canonicalJson(execution) ||
          inner.serviceIds.some((id) => !ids.includes(id))
        )
          throw Error("Lifecycle ownership cannot expand");
        return run();
      }
      lease =
        inherited?.lease ??
        (await control.acquireArtifactTargetLease({
          dataRoot: join(paths.infraDir, "data"),
          owner: authority,
          serviceIds: targets,
          signal: inner.signal,
        }));
      owning = true;
      try {
        await withWriterStep(async () => {
          assertConfigurationUnchanged(expected, "Lifecycle configuration revision conflict");
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
          const opened = await store.read();
          if (opened.phase !== "prepared") throw Error("Retained lifecycle can only be observed");
          receipt = opened;
        }, inner.signal);
        const result = await run();
        await withWriterStep(
          (owned) => checkpoint(owned, { phase: "complete", followUp: "complete" }),
          inner.signal,
        );
        return result;
      } catch (error) {
        await recordContainedFailure(error);
        throw error;
      } finally {
        owning = false;
      }
    },
    async validatePins(selected, signal) {
      await withWriterStep(async (owned) => {
        assertConfigurationUnchanged(expected, "Lifecycle configuration revision conflict");
        if (release.touchesReleasePinnedServices(selected)) {
          if (!releaseStoreLock) throw Error("Lifecycle release-store ownership unavailable");
          const overlay = await release.ensureReleaseOverlay({ releaseStoreLock });
          if (overlay.status === "held") throw new ServiceLifecycleCommandError(1, overlay.reason);
          if (overlay.status === "unpinned")
            throw new ServiceLifecycleCommandError(1, "Release selection unavailable");
        }
        await assertNativeCreation();
        releaseSelection = readReleaseSelection();
        await checkpoint(owned, { phase: "pins_validated" });
      }, signal);
    },
    async pull(selected, signal) {
      const conflict = "Lifecycle configuration revision conflict";
      await beforeDockerEffect(expected, conflict, signal);
      const code = await dockerComposeStream(["pull", ...selected]);
      if (code !== 0)
        throw new ServiceLifecycleCommandError(
          code,
          "Image pull failed; refusing to recreate services",
        );
      await withWriterStep(async (owned) => {
        assertConfigurationUnchanged(expected, conflict);
        await checkpoint(owned, { phase: "pulled" });
      }, signal);
    },
    async prepare({ coordinatorMode, signal }) {
      const rendered = await withWriterStep(async (owned) => {
        assertConfigurationUnchanged(expected, "Lifecycle configuration revision conflict");
        const committed = await renderComposeWithWriter(
          {
            expectedCurrentRevisionId: expected,
            revisionId: finalRevisionId,
          },
          owned.writer,
        );
        await checkpoint(owned, {
          phase: "generation_committed",
          finalRevisionId: committed.revisionId,
          commit: "final_committed",
        });
        if (ops.canonicalJson(readGeneratedHardlinkPlan().plan) !== ops.canonicalJson(plan))
          throw Error("Hardlink intent changed");
        return committed;
      }, signal);
      const conflict = "Lifecycle generation changed before hardlinks";
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
          await beforeDockerEffect(rendered.revisionId, conflict, signal);
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
      return withWriterStep(async (owned) => {
        assertConfigurationUnchanged(rendered.revisionId, conflict);
        const hardlinks = await control.executeOwnedGenerationHardlinks({
          authority,
          lease: owned.lease,
          infraDir: paths.infraDir,
          transport,
        });
        await checkpoint(owned, { phase: "hardlinks_applied", hardlinks });
        return { revisionId: rendered.revisionId, coordinatorMode, hardlinks };
      }, signal);
    },
    async recreate(selected, noDeps, signal) {
      const revisionId = committedRevisionId();
      const conflict = "Lifecycle generation changed before recreation";
      await assertNativeCreation();
      await refuseAgentSwitchOrExit(noDeps ? [...selected] : "all");
      if (selected.includes(API_SERVICE_ID)) {
        await beforeDockerEffect(revisionId, conflict, signal);
        const migrationCode = await migrateBeforeApiUpdate({ deps: !noDeps });
        if (migrationCode !== 0)
          throw new ServiceLifecycleCommandError(
            migrationCode,
            "Database migration failed; services were not replaced",
          );
      }
      await beforeDockerEffect(revisionId, conflict, signal);
      const code = await dockerComposeStream([
        "up",
        "-d",
        "--force-recreate",
        ...(noDeps ? ["--no-deps"] : []),
        ...selected,
      ]);
      if (code !== 0) throw new ServiceLifecycleCommandError(code, "Service recreation failed");
      await withWriterStep(async (owned) => {
        assertConfigurationUnchanged(revisionId, "Lifecycle generation changed during recreation");
        await checkpoint(owned, { phase: "recreated", followUp: "complete" });
      }, signal);
    },
  };
  const dataRoot = join(paths.infraDir, "data");
  /**
   * Runs in the process that recorded the failure, after every Docker effect has been
   * awaited. Only a hardlink child issued to data-manager can still be running, so
   * that case keeps its fence for `services recover-update`. The caller rethrows the
   * original failure, which a release failing here must not replace.
   */
  const releaseAfterContainedFailure = async () => {
    if (inherited || lease?.mode !== "owner") return;
    const held = lease,
      key = execution.operationKey;
    try {
      // A failure before the receipt opened has run nothing and has nothing to record.
      if (!receipt)
        control.retainControlEffectReceipt(authority, {
          outcome: "failed_without_effect",
          publication: "not_started",
          receipt: { kind: "not-started" },
        });
      else {
        const failed = await services.withServiceLifecycleReceiptAuthority(authority, () =>
          services.readServiceLifecycleReceipt({ dataRoot, execution }),
        );
        let attempt: unknown = null;
        try {
          if (reservation) attempt = control.lookupControlChildPhaseAttempt(authority, reservation);
        } catch (lookupError) {
          attempt = lookupError;
        }
        if (!services.lifecycleFailureHasNoSurvivor(failed, attempt)) {
          if (attempt !== null)
            log.warn(
              `Operation ${key} keeps its service locks because a hardlink request issued to data-manager may still be running. Inspect infra/docker/data/ops-agent/lifecycle/${key}.json; after its deadline, \`pnpm openmapx services recover-update --operation-key ${key}\` can release an unadopted request.`,
            );
          return;
        }
        control.retainControlEffectReceipt(authority, {
          outcome: "contained",
          publication: "committed",
          receipt: {
            kind: "service-lifecycle-contained-failure",
            failedReceiptDigest: control.controlDigest(failed),
          },
        });
      }
      await control.settleArtifactTargetLeaseChild(
        held,
        control.verifyControlEffectSettlement(installation, execution),
      );
      await control.releaseArtifactTargetLease(held);
      lease = undefined;
    } catch (releaseError) {
      log.warn(
        `Operation ${key} could not release its service locks: ${releaseError instanceof Error ? releaseError.message : "unknown error"}`,
      );
    }
  };
  try {
    await effects.withOwnership(request, async () => {
      if (options.action === "update")
        await runServiceUpdate({ ...request, noDeps: options.noDeps }, effects);
      else {
        await effects.validatePins(ids);
        await prepareServiceLifecycle({ ...request, coordinatorMode: "ensure-running" }, effects);
        const revisionId = committedRevisionId();
        await assertNativeCreation();
        await refuseAgentSwitchOrExit([...ids]);
        await beforeDockerEffect(revisionId, "Lifecycle generation changed before Start");
        const code = await dockerComposeStream([
          "up",
          "-d",
          ...(ids.includes("data-manager") ? ["--no-recreate"] : []),
          ...ids,
        ]);
        if (code !== 0) throw new ServiceLifecycleCommandError(code, "Service Start failed");
        await withWriterStep(async (owned) => {
          assertConfigurationUnchanged(revisionId, "Lifecycle generation changed during Start");
          await checkpoint(owned, { phase: "recreated", followUp: "complete" });
        });
      }
    });
    if (!inherited && lease?.mode === "owner") {
      const verified = await services.withServiceLifecycleReceiptAuthority(authority, () =>
        services.readServiceLifecycleReceipt({ dataRoot, execution }),
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
    await releaseAfterContainedFailure();
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
