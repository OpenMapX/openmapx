import { adminArtifactImportInputSchema } from "@openmapx/core/api-contracts";
import { z } from "zod/v4";
import { AdminJobFailure } from "./admin-job-failure";
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

export async function handlePreparedArtifactImportJob(
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  await assertRetainedMaintenanceJob(ctx);
  const stageId = z.uuid().parse(ctx.payload.stageId),
    ownerId = z.string().min(1).max(128).parse(ctx.payload.ownerId);
  if ((ctx.payload._maintenanceRequest as { actorId?: string }).actorId !== ownerId)
    throw Error("Original artifact owner required");
  const input = adminArtifactImportInputSchema.parse({
    expectedSha256: ctx.payload.expectedSha256,
    previewFingerprint: ctx.payload.previewFingerprint,
    expectedCurrentRevisionId: ctx.payload.expectedCurrentRevisionId,
  });
  const result = await executeAdminJobOperation(
    ctx,
    { kind: "artifactTransfer.import", stageId, ownerId, ...input },
    "admin-job.artifact.import",
  );
  const receipt = { operation: "import-artifact", publication: result };
  if (result.outcome !== "committed" || result.followUp !== "complete")
    throw new AdminJobFailure(
      result.outcome === "committed"
        ? "Artifacts committed; hardlink follow-up failed. Keep consumers stopped and reconcile before starting."
        : "Prepared artifacts were not committed; refresh the preview before a new deliberate attempt.",
      receipt,
    );
  return receipt;
}
