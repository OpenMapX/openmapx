import { adminComposeRenderInputSchema } from "@openmapx/core/api-contracts";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import { hasRetainedAdminJobOperation } from "./admin-job-ops";
import { JobOwnershipLost } from "./admin-job-state";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey, OpsObservationPending } from "./ops-client";
import { resumeRetainedConfigurationCandidate } from "./prospective-configuration";
import { assertRetainedMaintenanceJob } from "./retained-maintenance-authorization";
import { applyGenerationHardlinks, publishServiceGeneration } from "./service-preparation";
import {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
} from "./trusted-config-outcome";

export async function handleComposeRenderJob(ctx: JobContext): Promise<Record<string, unknown>> {
  await assertRetainedMaintenanceJob(ctx);
  const { expectedCurrentRevisionId } = adminComposeRenderInputSchema.parse({
    expectedCurrentRevisionId: ctx.payload.expectedCurrentRevisionId,
    confirmed: ctx.payload.confirmed,
  });
  if (ctx.payload.coordinatorMode !== "require-running")
    throw Error("Render-only requires the admitted running-coordinator mode");
  const operationKey = createDurableOpsKey(
    "admin-job.config.prepare",
    `${ctx.jobId}:compose-render`,
  );
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { actorId: ctx.jobId, operationKey, integrationIds: [], signal: ctx.signal },
      async () => {
        let revisionId: string;
        if (
          ctx.execution &&
          ctx.execution.version >= 2 &&
          ctx.checkpointResult?._configurationCandidate &&
          !hasRetainedAdminJobOperation(ctx, operationKey)
        ) {
          const resumed = await resumeRetainedConfigurationCandidate(),
            application = parseTrustedConfigurationApplyOutcome(resumed.configuration);
          if (
            !completeTrustedConfigurationApply(application) ||
            application.outcome !== "committed"
          )
            throw new AdminJobFailure(
              "Original configuration generation did not complete",
              resumed,
            );
          revisionId = application.revisionId;
        } else
          ({ revisionId } = await publishServiceGeneration(ctx, "compose-render", {
            coordinatorMode: "require-running",
            expectedCurrentRevisionId,
          }));
        const configuration = {
          outcome: "committed",
          revisionId,
          followUp: "not_started",
          restartRequired: true,
        };
        await ctx.checkpoint({ ...ctx.checkpointResult, configuration });
        try {
          const hardlinks = await applyGenerationHardlinks({
            ctx,
            revisionId,
            coordinatorMode: "require-running",
            operationIdentity: `${ctx.jobId}:compose-render`,
            signal: ctx.signal,
            log: (message) => ctx.log(message),
          });
          return {
            operation: "render-compose",
            configuration: { ...configuration, followUp: "complete" },
            hardlinks,
            message: "Configuration generated. Container application is still pending.",
          };
        } catch (error) {
          if (
            error instanceof JobObservationPending ||
            error instanceof OpsObservationPending ||
            error instanceof JobOwnershipLost ||
            ctx.signal.aborted
          )
            throw error;
          throw new AdminJobFailure(
            "Configuration generated; hardlinks did not complete. Container application is still pending.",
            { ...ctx.checkpointResult, configuration: { ...configuration, followUp: "failed" } },
          );
        }
      },
    ),
  );
}
