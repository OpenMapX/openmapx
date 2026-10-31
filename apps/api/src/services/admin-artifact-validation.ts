import {
  adminArtifactExportInputSchema,
  adminArtifactImportInputSchema,
} from "@openmapx/core/api-contracts";
import {
  artifactPublicationResultSchema,
  canonicalJson,
  type OpsOperation,
  stageClaimIdentitySchema,
  transferStageSchema,
} from "@openmapx/core/ops";
import { z } from "zod/v4";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import { ensureAdminJobReceiptDelivery, executeAdminJobOperation } from "./admin-job-ops";
import { readProjection } from "./admin-job-projection";
import {
  purposeObservationSchema,
  readArtifactPurposeObservation,
} from "./artifact-purpose-observation";
import type { JobContext } from "./job-runner";
import { createApiOpsClient } from "./ops-client";
import { assertRetainedMaintenanceJob } from "./retained-maintenance-authorization";

/** Observation never submits a second import/validation. Copy the exact purpose
 * receipt into the owned SQL checkpoint BEFORE acknowledging its immutable
 * canonical operation, so later family/stage retirement cannot erase the result. */
async function recoverArtifactPurpose(
  ctx: JobContext,
  operation: Extract<
    OpsOperation,
    { kind: "artifactTransfer.import" | "artifactTransfer.validate" }
  >,
  originalError: unknown,
) {
  const projection = readProjection(ctx.checkpointResult),
    projected = Object.values(projection.operations).find(
      (value) =>
        value.kind === operation.kind &&
        canonicalJson(value.operation) === canonicalJson(operation),
    );
  if (!projected?.operationId || !projected.fingerprint || !projected.deadlineAt)
    throw originalError;
  const identity = {
      executionId: projected.operationId,
      operationKey: projected.operationKey,
      fingerprint: projected.fingerprint,
      executionDeadlineAt: new Date(projected.deadlineAt).toISOString(),
    },
    client = createApiOpsClient();
  let observation = readArtifactPurposeObservation(ctx.checkpointResult, operation, identity);
  if (!observation) {
    try {
      const observed = await client.execute({
        kind: "artifactTransfer.inspectClaim",
        stageId: operation.stageId,
        ownerId: operation.ownerId,
        identity,
      });
      if (
        observed.execution !== "sync" ||
        !observed.value ||
        canonicalJson(observed.value.claim.identity) !== canonicalJson(identity)
      )
        throw originalError;
      const value = observed.value,
        base = {
          kind: operation.kind,
          stageId: operation.stageId,
          ownerId: operation.ownerId,
          sha256: value.claim.sha256,
          identity,
        };
      if (operation.kind === "artifactTransfer.import") {
        if (
          value.claim.use !== "import-build" ||
          value.claim.sha256 !== operation.expectedSha256 ||
          !["consumed", "released"].includes(value.settlement?.outcome ?? "") ||
          !value.publication
        )
          throw originalError;
        if (
          value.publication.outcome === "committed"
            ? value.settlement?.outcome !== "consumed"
            : value.settlement?.outcome !== "released"
        )
          throw originalError;
        observation = purposeObservationSchema.parse({ ...base, publication: value.publication });
      } else {
        if (
          value.claim.use !== "validate-build" ||
          !["failed", "validated"].includes(value.settlement?.outcome ?? "") ||
          value.validation?.stageId !== operation.stageId ||
          !["failed", "ready"].includes(value.validation.state) ||
          (value.validation.state === "failed" && value.validation.cleanup !== "complete") ||
          value.validation.sha256 !== value.claim.sha256
        )
          throw originalError;
        observation = purposeObservationSchema.parse({ ...base, stage: value.validation });
      }
    } catch {
      // A terminal host error alone cannot decide whether an admitted import
      // published files. Keep observing its original purpose receipt.
      throw new JobObservationPending("recovery_required");
    }
    await ctx.checkpoint({ ...ctx.checkpointResult, _artifactPurposeObservation: observation });
  }
  let canonical: import("@openmapx/core/ops").OpsJobStatus;
  try {
    canonical =
      projected.receiptDelivery?.terminalReceipt ??
      (await client.status(operation.kind, projected.operationId));
  } catch {
    throw new JobObservationPending("receipt_delivery");
  }
  if (
    !["succeeded", "failed", "timed_out"].includes(canonical.state) ||
    canonical.kind !== projected.kind ||
    canonical.operationId !== projected.operationId ||
    canonical.operationKey !== projected.operationKey ||
    canonical.fingerprint !== projected.fingerprint ||
    canonical.deadlineAt !== projected.deadlineAt
  )
    throw new JobObservationPending("invalid_identity");
  // The old observer may have stopped before checkpointing terminal state.
  // Copy the actual immutable canonical projection before attaching its delivery.
  projected.terminal = true;
  projected.phase = "terminal";
  delete projected.outcome;
  if (canonical.result === undefined) delete projected.result;
  else projected.result = canonical.result;
  if (canonical.errorClass === undefined) delete projected.errorClass;
  else projected.errorClass = canonical.errorClass;
  if (canonical.failureResult === undefined) delete projected.failureResult;
  else projected.failureResult = canonical.failureResult;
  await ensureAdminJobReceiptDelivery(ctx, projection, projected, client, canonical);
  return observation;
}

export async function handlePreparedArtifactExportJob(
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  await assertRetainedMaintenanceJob(ctx);
  const ownerId = z.string().min(1).max(128).parse(ctx.payload.ownerId);
  if ((ctx.payload._maintenanceRequest as { actorId?: string }).actorId !== ownerId)
    throw Error("Original artifact owner required");
  const input = adminArtifactExportInputSchema.parse({
    serviceId: ctx.payload.serviceId,
    expectedArtifactFingerprint: ctx.payload.expectedArtifactFingerprint,
  });
  const stage = await executeAdminJobOperation(
    ctx,
    { kind: "artifactTransfer.export", ownerId, ...input },
    "admin-job.artifact.export",
  );
  return { operation: "export-artifact", stage };
}
export async function handlePreparedArtifactValidationJob(
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  await assertRetainedMaintenanceJob(ctx);
  const stageId = z.uuid().parse(ctx.payload.stageId),
    ownerId = z.string().min(1).max(128).parse(ctx.payload.ownerId);
  if ((ctx.payload._maintenanceRequest as { actorId?: string }).actorId !== ownerId)
    throw Error("Original artifact owner required");
  const operation = {
    kind: "artifactTransfer.validate" as const,
    stageId,
    ownerId,
    purpose: "prepared-artifact" as const,
  };
  let stage: import("@openmapx/core/ops").TransferStage;
  try {
    stage = await executeAdminJobOperation(ctx, operation, "admin-job.artifact.validate");
  } catch (originalError) {
    const recovered = await recoverArtifactPurpose(ctx, operation, originalError);
    if (recovered.kind !== "artifactTransfer.validate") throw originalError;
    stage = recovered.stage;
  }
  const receipt = { operation: "validate-artifact", stage };
  if (stage.state !== "ready")
    throw new AdminJobFailure(
      "Prepared archive validation failed; its contained private bytes were reclaimed. Upload a new archive to retry.",
      receipt,
    );
  return receipt;
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
  const operation = { kind: "artifactTransfer.import" as const, stageId, ownerId, ...input };
  let result: import("@openmapx/core/ops").OpsResultFor<"artifactTransfer.import">;
  try {
    result = await executeAdminJobOperation(ctx, operation, "admin-job.artifact.import");
  } catch (originalError) {
    const recovered = await recoverArtifactPurpose(ctx, operation, originalError);
    if (recovered.kind !== "artifactTransfer.import") throw originalError;
    result = recovered.publication;
  }
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
