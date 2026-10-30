/** The ordinary backup finishes before the existing owned configuration root.
 * Release application itself uses the same nominal platform participant/helper. */
import { adminPlatformConfirmationSchema } from "@openmapx/core/api-contracts";
import { configurationGenerationRevisionSchema } from "@openmapx/core/ops";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { adminJob, user } from "../db/schema";
import { getAllIntegrations } from "../integration-host";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import { executeAdminJobOperation } from "./admin-job-ops";
import { jobOwnership } from "./admin-job-state";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer-owner";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";
import { applyPlatformConfigurationIntent } from "./platform-configuration-application";
import {
  guardedSystemReleasePayloadSchema,
  platformJobMatchesPreview,
} from "./platform-configuration-job";
import {
  inspectPlatformConfiguration,
  previewPlatformConfiguration,
} from "./platform-configuration-view";
import { readPlatformPreview } from "./platform-preview-store";
import {
  resumeRetainedConfigurationCandidate,
  retainedConfigurationIntegrationIds,
} from "./prospective-configuration";
import {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
} from "./trusted-config-outcome";

const checkpointSchema = z.strictObject({
  version: z.literal(1),
  actorId: z.string().min(1).max(128),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedCurrentRevisionId: configurationGenerationRevisionSchema.nullable(),
  confirmations: adminPlatformConfirmationSchema,
});
export async function runGuardedSystemRelease(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = guardedSystemReleasePayloadSchema.parse(ctx.payload);
  if (ctx.jobType !== "system.update" || !ctx.execution)
    throw new JobObservationPending("invalid_identity");
  const [job] = await db
    .select()
    .from(adminJob)
    .where(jobOwnership(ctx.jobId, ctx.execution, ["running", "cancel_pending"]));
  if (!job?.createdBy || job.type !== "system.update")
    throw new JobObservationPending("invalid_identity");
  const actorId = job.createdBy,
    operationKey = createDurableOpsKey("admin-job.guarded-release", ctx.jobId),
    retained = ctx.checkpointResult?._configurationCandidate;
  let fixed =
    ctx.checkpointResult?._systemRelease === undefined
      ? undefined
      : checkpointSchema.parse(ctx.checkpointResult._systemRelease);
  if (!retained) {
    const [actor] = await db.select().from(user).where(eq(user.id, actorId));
    if (actor?.role !== "admin" || actor.banned === true)
      throw new AdminJobFailure("Release administrator is unavailable", { errorCode: "forbidden" });
    if (ctx.observationOnly) throw new JobObservationPending("recovery_required");
    if (payload.createBackup !== false) {
      await ctx.log("Creating a backup before applying the checked release");
      await executeAdminJobOperation(
        ctx,
        { kind: "backup.create", backupId: `pre-update-${ctx.jobId}` },
        "admin-job.guarded-release.backup",
      );
    }
    if (!fixed) {
      const current = await inspectPlatformConfiguration(),
        reviewed = await previewPlatformConfiguration({
          actorId,
          operationKey: createDurableOpsKey("admin-job.release.preview", ctx.jobId),
          expectedCurrentRevisionId: current.expectedCurrentRevisionId,
          changes: { version: 1 },
          release: { releaseId: payload.releaseId, manifestDigest: payload.expectedDigest },
        });
      fixed = checkpointSchema.parse({
        version: 1,
        actorId,
        operationKey,
        previewFingerprint: reviewed.preview.previewFingerprint,
        expectedCurrentRevisionId: reviewed.preview.expectedCurrentRevisionId,
        confirmations: reviewed.preview.requiredConfirmation,
      });
      const result = { ...ctx.checkpointResult, _systemRelease: fixed };
      await ctx.checkpoint(result, 15);
      ctx.checkpointResult = result;
    }
  }
  if (!fixed || fixed.actorId !== actorId || fixed.operationKey !== operationKey)
    throw new JobObservationPending("invalid_identity");
  if (!retained) {
    const reviewed = await readPlatformPreview({
      actorId,
      previewFingerprint: fixed.previewFingerprint,
    });
    if (!platformJobMatchesPreview(job, reviewed.preview))
      throw new JobObservationPending("invalid_identity");
  }
  const integrationIds = retained
    ? await retainedConfigurationIntegrationIds(ctx, actorId, operationKey)
    : getAllIntegrations().map((value) => value.id);
  const input = fixed;
  const result = await withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { actorId, operationKey, integrationIds, signal: ctx.signal },
      async () => {
        if (retained) return resumeRetainedConfigurationCandidate();
        const applied = await applyPlatformConfigurationIntent(input);
        return { configuration: applied.application };
      },
    ),
  );
  const configuration = parseTrustedConfigurationApplyOutcome(result.configuration),
    output = { operation: "apply", release: payload.releaseId, phase: "complete", configuration };
  if (!completeTrustedConfigurationApply(configuration))
    throw new AdminJobFailure("Checked release did not apply completely", output);
  await ctx.setProgress(100);
  return output;
}
