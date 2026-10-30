import {
  createServiceBatchResult,
  type OpsResultFor,
  serviceBatchResultSchema,
} from "@openmapx/core/ops";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import { executeAdminJobOperation } from "./admin-job-ops";
import { JobOwnershipLost } from "./admin-job-state";
import { assertKnownServiceIds } from "./admin-operation-input";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer";
import type { JobContext } from "./job-runner";
import {
  ApiOpsError,
  createApiOpsClient,
  createDurableOpsKey,
  executeAndWait,
  OpsObservationPending,
} from "./ops-client";
import { checkpointServiceBatch, finishServiceBatch } from "./service-batch-result";
export async function handleImageStageJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const ids = ctx.payload.serviceIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 64 ||
    !ids.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw Error("Select1–64 installed services");
  assertKnownServiceIds(ids);
  const operationKey = createDurableOpsKey("service.images.pull", ctx.jobId);
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { actorId: ctx.jobId, operationKey, integrationIds: [], signal: ctx.signal },
      async () => {
        let revision = ctx.checkpointResult?._imageStageRevisionId;
        if (revision === undefined) {
          const current = await executeAndWait(
            createApiOpsClient(),
            { kind: "configuration.inspect" },
            createDurableOpsKey("image-stage.current", ctx.jobId),
            { signal: ctx.signal },
          );
          if (!current.revisionId)
            throw new AdminJobFailure("Generate configuration before staging images", {});
          revision = current.revisionId;
          await ctx.checkpoint({ ...ctx.checkpointResult, _imageStageRevisionId: revision });
        }
        if (typeof revision !== "string" || !/^cfg1_[A-Za-z0-9_-]{43}$/.test(revision))
          throw new JobObservationPending("invalid_identity");
        const completed: string[] = [],
          failed: string[] = [],
          images: ({ serviceId: string } & OpsResultFor<"service.image.stage">)[] = [];
        const retained = serviceBatchResultSchema.safeParse(ctx.checkpointResult?.serviceBatch);
        // Original step receipts remain the only effect authority; replaying the loop
        // observes them by stable address and never substitutes a fresh revision.
        if (retained.success && retained.data.failedServiceIds.length)
          throw new AdminJobFailure("Image staging failed", {
            ...ctx.checkpointResult,
            serviceBatch: retained.data,
          });
        for (const [index, serviceId] of ids.entries()) {
          ctx.signal.throwIfAborted();
          try {
            const result = await executeAdminJobOperation(
              ctx,
              { kind: "service.image.stage", serviceId, expectedConfigurationRevisionId: revision },
              "admin-job.image.stage",
              { durableIdentity: `${index}:${serviceId}` },
            );
            completed.push(serviceId);
            images.push({ serviceId, ...result });
            await ctx.checkpoint({ ...ctx.checkpointResult, images });
          } catch (error) {
            const unknown =
              error instanceof OpsObservationPending ||
              error instanceof JobObservationPending ||
              error instanceof JobOwnershipLost ||
              ctx.signal.aborted ||
              (error instanceof ApiOpsError &&
                ["recovery_required", "timeout"].includes(error.errorClass));
            if (!unknown) failed.push(serviceId);
            const batch = createServiceBatchResult(ids, completed, failed, ids.slice(index + 1));
            await checkpointServiceBatch(ctx, batch);
            if (unknown) throw error;
            throw new AdminJobFailure(
              "Image staging failed; configured references and containers were not changed",
              { ...ctx.checkpointResult, images, serviceBatch: batch },
            );
          }
          await checkpointServiceBatch(
            ctx,
            createServiceBatchResult(ids, completed, failed, ids.slice(index + 1)),
          );
        }
        const serviceBatch = await finishServiceBatch(
          ctx,
          createServiceBatchResult(ids, completed, failed, []),
        );
        return { operation: "stage-images", images, serviceBatch };
      },
    ),
  );
}
