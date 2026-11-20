import type { CoordinatorMode, ServicePreparationResult } from "@openmapx/core/ops";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import {
  executeAdminJobOperation,
  hasRetainedAdminJobOperation,
  retainedAdminJobOperation,
} from "./admin-job-ops";
import { readAdminJobProtocol } from "./admin-job-state";
import {
  currentAdministrativeConfigurationWriter,
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer";
import { applyGenerationHardlinks } from "./configuration-hardlinks";
import {
  coordinatorLifecycleOperationKey,
  prepareCoordinatorLifecycleIntent,
} from "./coordinator-lifecycle";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import {
  persistAndApplyProspectiveConfiguration,
  prepareProspectiveConfiguration,
  resumeConfigurationCandidate,
} from "./prospective-configuration";
import {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
} from "./trusted-config-outcome";
import { applyTrustedConfiguration } from "./trusted-configuration-producer";

/** Fixed current queued DM producer. A nominal intent, unchanged full candidate
 * and the existing maintenance persister own the entire continuation. */
export async function applyCoordinatorService(
  ctx: JobContext,
  originalOrdinal: number | null,
  expectedCurrentRevisionId?: string,
) {
  const operationKey = coordinatorLifecycleOperationKey(ctx.jobId, originalOrdinal),
    retained = readAdminJobProtocol(ctx.protocol).candidate;
  // A batch that moved on to its next candidate keeps this step's outcome.
  const finished = (
    ctx.checkpointResult?._configurationOutcomes as Record<string, unknown> | undefined
  )?.[operationKey];
  if (finished && retained?.operationKey !== operationKey) {
    const applied = parseTrustedConfigurationApplyOutcome(finished);
    if (!completeTrustedConfigurationApply(applied) || applied.outcome !== "committed")
      throw new JobObservationPending("invalid_identity");
    return { changed: true as const, revisionId: applied.revisionId };
  }
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { actorId: ctx.jobId, operationKey, integrationIds: [], signal: ctx.signal },
      async () => {
        let application: unknown;
        if (retained?.operationKey === operationKey) {
          const result = await resumeConfigurationCandidate();
          application = result.configuration;
        } else {
          const current = await executeAndWait(
            createApiOpsClient(),
            { kind: "configuration.inspect" },
            createDurableOpsKey("configuration.coordinator-current", operationKey),
            { signal: ctx.signal },
          );
          if (
            !current.revisionId ||
            (expectedCurrentRevisionId !== undefined &&
              current.revisionId !== expectedCurrentRevisionId)
          )
            throw new AdminJobFailure("Coordinator current configuration changed", {});
          const intent = await prepareCoordinatorLifecycleIntent(
              currentAdministrativeConfigurationWriter(),
              originalOrdinal,
            ),
            candidate = await prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey,
              expectedCurrentRevisionId: current.revisionId,
              overlay: { purpose: "render", coordinatorMode: "ensure-running", changes: [] },
              coordinatorIntent: intent,
              signal: ctx.signal,
            });
          application = (
            await persistAndApplyProspectiveConfiguration(candidate, {
              coordinatorMode: "ensure-running",
              signal: ctx.signal,
            })
          ).application;
        }
        const applied = parseTrustedConfigurationApplyOutcome(application);
        if (
          applied.outcome !== "committed" ||
          applied.followUp !== "complete" ||
          !completeTrustedConfigurationApply(applied)
        )
          throw new AdminJobFailure("Coordinator configuration did not complete", {
            configuration: application,
          });
        return { changed: true as const, revisionId: applied.revisionId };
      },
    ),
  );
}

export type { CoordinatorMode, ServicePreparationResult } from "@openmapx/core/ops";

/** Bulk and single Update carry the exact prior target's own final revision. */
export async function updatePreparedService(
  ctx: JobContext,
  serviceId: string,
  revisionId: string,
  noDeps = false,
) {
  const address = createDurableOpsKey("admin-job.service.update", `${ctx.jobId}:${serviceId}`);
  if (hasRetainedAdminJobOperation(ctx, address)) {
    const original = retainedAdminJobOperation(ctx, address);
    if (
      original?.kind !== "service.update" ||
      original.serviceId !== serviceId ||
      original.expectedConfigurationRevisionId !== revisionId ||
      (original.noDeps ?? false) !== noDeps
    )
      throw new JobObservationPending("invalid_identity");
    return executeAdminJobOperation(ctx, original, "admin-job.service.update", {
      durableIdentity: serviceId,
    });
  }
  const current = await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.inspect" },
    createDurableOpsKey("admin-job.update.inspect", `${ctx.jobId}:${serviceId}`),
    { signal: ctx.signal },
  );
  if (current.revisionId !== revisionId)
    throw new AdminJobFailure("Configuration changed before the next Update target", {
      serviceLifecycle: {
        expectedRevisionId: revisionId,
        seedRevisionId: revisionId,
        finalRevisionId: null,
        phase: "failed",
        commit: "seed_committed",
        followUp: "not_started",
        failure: { reason: "revision_conflict", failedServiceIds: [serviceId] },
      },
    });
  return executeAdminJobOperation(
    ctx,
    {
      kind: "service.update",
      serviceId,
      expectedConfigurationRevisionId: revisionId,
      ...(noDeps ? { noDeps } : {}),
    },
    "admin-job.service.update",
    { durableIdentity: serviceId },
  );
}

/** Publication is a seed/commit receipt, not proof of hardlinks or service application. */
export async function publishServiceGeneration(
  ctx: JobContext,
  scope: string,
  options: { coordinatorMode: CoordinatorMode; expectedCurrentRevisionId?: string | null },
): Promise<{ revisionId: string }> {
  return applyTrustedConfiguration({
    ctx,
    kind: "stack.render",
    coordinatorMode: options.coordinatorMode,
    ...(Object.hasOwn(options, "expectedCurrentRevisionId")
      ? { expectedCurrentRevisionId: options.expectedCurrentRevisionId! }
      : {}),
    operationKey: createDurableOpsKey("admin-job.config.prepare", `${ctx.jobId}:${scope}`),
    signal: ctx.signal,
  });
}

export { applyGenerationHardlinks } from "./configuration-hardlinks";

export async function prepareServiceGeneration(
  ctx: JobContext,
  scope: string,
  options: { coordinatorMode: CoordinatorMode },
): Promise<ServicePreparationResult> {
  const previous = (
    ctx.checkpointResult?._servicePreparations as
      | Record<string, ServicePreparationResult>
      | undefined
  )?.[scope];
  if (previous) {
    if (previous.coordinatorMode !== options.coordinatorMode)
      throw new JobObservationPending("invalid_identity");
    return previous;
  }
  await ctx.log("Preparing the full selected service generation...");
  const { revisionId } = await publishServiceGeneration(ctx, scope, options);
  const hardlinks = await applyGenerationHardlinks({
    ctx,
    revisionId,
    operationIdentity: `${ctx.jobId}:${scope}`,
    coordinatorMode: options.coordinatorMode,
    signal: ctx.signal,
    log: (message) => ctx.log(message),
  });
  const result = { revisionId, hardlinks, coordinatorMode: options.coordinatorMode };
  await ctx.checkpoint({
    ...ctx.checkpointResult,
    _servicePreparations: {
      ...(ctx.checkpointResult?._servicePreparations as Record<string, unknown>),
      [scope]: result,
    },
  });
  return result;
}
