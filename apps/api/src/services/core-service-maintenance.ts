import { configurationGenerationRevisionSchema, type OpsOperation } from "@openmapx/core/ops";
import { AdminJobFailure } from "./admin-job-failure";
import { executeAdminJobOperation, retainedAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";

export async function runCoreServiceMaintenance(ctx: JobContext): Promise<Record<string, unknown>> {
  const serviceId = ctx.payload.service;
  if (serviceId !== "app-api" && serviceId !== "traefik")
    throw new AdminJobFailure("Core service restart is not available", {});
  const address = createDurableOpsKey(
    "admin-job.service.core-restart",
    `${ctx.jobId}:${serviceId}`,
  );
  const original = retainedAdminJobOperation(ctx, address);
  let operation: Extract<OpsOperation, { kind: "coreService.restart" }>;
  if (original) {
    if (original.kind !== "coreService.restart" || original.serviceId !== serviceId)
      throw new AdminJobFailure("Retained core restart conflicts", {});
    operation = original;
  } else {
    const current = await executeAndWait(
      createApiOpsClient(),
      { kind: "configuration.inspect" },
      createDurableOpsKey("admin-job.core-restart.inspect", ctx.jobId),
      { signal: ctx.signal },
    );
    const revision = configurationGenerationRevisionSchema.safeParse(current.revisionId);
    if (!revision.success) throw new AdminJobFailure("No applied configuration is available", {});
    operation = {
      kind: "coreService.restart" as const,
      serviceId,
      expectedConfigurationRevisionId: revision.data,
    };
  }
  await ctx.checkpoint({
    ...ctx.checkpointResult,
    _completion: { operationKey: address, result: { service: serviceId, action: "restart" } },
  });
  await executeAdminJobOperation(ctx, operation, "admin-job.service.core-restart", {
    durableIdentity: serviceId,
  });
  return { service: serviceId, action: "restart" };
}
