import { executeAdminJobOperation } from "./admin-job-ops";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";
import { assertRetainedMaintenanceJob } from "./retained-maintenance-authorization";
export async function handleReleaseClearJob(ctx: JobContext): Promise<Record<string, unknown>> {
  await assertRetainedMaintenanceJob(ctx);
  const releaseId = ctx.payload.expectedReleaseId;
  if (typeof releaseId !== "string" || ctx.payload.confirmation !== "CLEAR RELEASE PIN")
    throw Error("Exact release pin confirmation required");
  const operationKey = createDurableOpsKey("release.clear", ctx.jobId);
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { actorId: ctx.jobId, operationKey, integrationIds: [], signal: ctx.signal },
      async () => {
        const result = await executeAdminJobOperation(
          ctx,
          { kind: "release.clear", releaseId },
          "admin-job.release.clear",
        );
        return { operation: "clear-release-pin", ...result };
      },
    ),
  );
}
