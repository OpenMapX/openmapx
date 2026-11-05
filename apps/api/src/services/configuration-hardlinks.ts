import type { CoordinatorMode, HardlinkApplySummary } from "@openmapx/core/ops";
import { JobObservationPending } from "./admin-job-failure";
import { executeAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";

export async function applyGenerationHardlinks(options: {
  revisionId: string;
  operationIdentity: string;
  coordinatorMode: CoordinatorMode;
  signal?: AbortSignal;
  ctx?: JobContext;
  log?: (message: string) => Promise<void> | void;
}): Promise<HardlinkApplySummary> {
  const ctx = options.ctx;
  if (!ctx) throw Error("A retained configuration job is required");
  const legacy = (
    ctx.checkpointResult?._hardlinkAttempts as
      | Record<string, { revisionId?: string; phase?: string; result?: HardlinkApplySummary }>
      | undefined
  )?.[options.operationIdentity];
  if (legacy) {
    if (legacy.revisionId !== options.revisionId || legacy.phase !== "complete" || !legacy.result)
      throw new JobObservationPending("recovery_required");
    return legacy.result;
  }
  const { plan } = await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.hardlinks.inspect", revisionId: options.revisionId },
    createDurableOpsKey("admin-job.hardlinks.inspect", options.operationIdentity),
    { signal: ctx.signal },
  );
  if (!plan.length)
    return { applied: true, entries: 0, linked: 0, skipped: 0, pruned: 0, via: "none" };
  if (options.coordinatorMode === "ensure-running") {
    await options.log?.("Ensuring data-manager is running for prepared hardlinks...");
    await executeAdminJobOperation(
      ctx,
      {
        kind: "service.start",
        serviceId: "data-manager",
        expectedConfigurationRevisionId: options.revisionId,
      },
      "admin-job.hardlinks.start",
      { durableIdentity: options.operationIdentity },
    );
  }
  return executeAdminJobOperation(
    ctx,
    {
      kind: "configuration.hardlinks.apply",
      revisionId: options.revisionId,
      coordinatorMode: options.coordinatorMode,
    },
    "admin-job.hardlinks.apply",
    { durableIdentity: options.operationIdentity },
  );
}
