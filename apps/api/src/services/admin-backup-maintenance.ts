import { backupPruneProofSchema } from "@openmapx/core/ops";
import { executeAdminJobOperation } from "./admin-job-ops";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";
import { assertRetainedMaintenanceJob } from "./retained-maintenance-authorization";
export async function handleBackupPruneJob(ctx: JobContext): Promise<Record<string, unknown>> {
  await assertRetainedMaintenanceJob(ctx);
  if (ctx.payload.confirmation !== "PRUNE EXPIRED BACKUPS")
    throw Error("Confirm the backup prune preview");
  const proof = backupPruneProofSchema.parse(ctx.payload.proof),
    operationKey = createDurableOpsKey("backup.prune", ctx.jobId);
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { actorId: ctx.jobId, operationKey, integrationIds: [], signal: ctx.signal },
      async () => {
        const result = await executeAdminJobOperation(
          ctx,
          { kind: "backup.prune", proof },
          "admin-job.backup.prune",
        );
        return { operation: "prune-backups", ...result };
      },
    ),
  );
}
