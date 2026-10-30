import { z } from "zod/v4";
import { executeAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";
import { assertRetainedMaintenanceJob } from "./retained-maintenance-authorization";
export async function handlePreparedArtifactValidationJob(
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  await assertRetainedMaintenanceJob(ctx);
  const stageId = z.uuid().parse(ctx.payload.stageId),
    ownerId = z.string().min(1).max(128).parse(ctx.payload.ownerId);
  if ((ctx.payload._maintenanceRequest as { actorId?: string }).actorId !== ownerId)
    throw Error("Original artifact owner required");
  const stage = await executeAdminJobOperation(
    ctx,
    { kind: "artifactTransfer.validate", stageId, ownerId, purpose: "prepared-artifact" },
    "admin-job.artifact.validate",
  );
  return { operation: "validate-artifact", stage };
}
