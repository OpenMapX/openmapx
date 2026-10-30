/** Job selectors are data, never host or configuration-participant authority. */
import type { AdminPlatformPreview } from "@openmapx/core/api-contracts";
import { configurationReleaseSelectionSchema } from "@openmapx/core/ops";
import { z } from "zod";

export const guardedSystemReleasePayloadSchema = z.strictObject({
  operation: z.literal("apply"),
  workflow: z.literal("guarded-release"),
  createBackup: z.boolean().optional(),
  releaseId: configurationReleaseSelectionSchema.shape.releaseId,
  expectedDigest: configurationReleaseSelectionSchema.shape.manifestDigest,
});
/** Additional rejection predicate. The actual actor, owned row, original MAC
 * candidate, preview and frozen controls must still pass their own checks. */
export function platformJobMatchesPreview(
  job: { type: string; payload: unknown },
  preview: Pick<AdminPlatformPreview, "release">,
) {
  if (job.type === "platform.apply") return true;
  if (job.type !== "system.update" || !preview.release) return false;
  const payload = guardedSystemReleasePayloadSchema.safeParse(job.payload);
  return (
    payload.success &&
    payload.data.releaseId === preview.release.releaseId &&
    payload.data.expectedDigest === preview.release.manifestDigest
  );
}
