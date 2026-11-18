import {
  applyGenerationLinks,
  GenerationLinkNotApplied,
  GenerationLinkUnknown,
  readGenerationHardlinkPlan,
  type TargetLeaseAuthority,
} from "@openmapx/core/build-artifacts";
import {
  createDataManagerTransport,
  getStatus,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import type { ExecutionRef, HardlinkApplySummary } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { readDataManagerToken } from "@openmapx/core/service-secret-files";
import { type OpsExecutionContext, OpsExecutionFailure, type OpsRuntime } from "./runtime";

export function configurationDataManagerTransport() {
  return createDataManagerTransport({
    baseUrl: process.env.DATA_MANAGER_URL?.trim() || "http://data-manager:4000",
    authToken: readDataManagerToken(),
    requestTimeoutMs: 15000,
    maxJsonBytes: 65536,
  });
}
export async function assertConfigurationCoordinatorReady(signal?: AbortSignal) {
  const status = unwrapDataManagerResponse(
    await getStatus({ transport: configurationDataManagerTransport(), signal }),
  );
  if (!status.ok || status.status !== "ready") throw Error("Configuration coordinator unavailable");
}

/**
 * Applies the current generation's hardlink plan for an operation the agent
 * runs under `lease`, through data-manager's `/link`, while holding the
 * generation writer so the generation cannot change underneath. A plan
 * data-manager did not apply fails the operation without effect; one whose
 * outcome data-manager never reported leaves it needing recovery, with its
 * lease held.
 */
export async function applyAgentGenerationLinks(options: {
  infraDir: string;
  revisionId: string;
  execution: ExecutionRef;
  lease: TargetLeaseAuthority;
  signal: AbortSignal;
}): Promise<HardlinkApplySummary> {
  try {
    return await services.withConfigurationGenerationWriter(
      options.infraDir,
      () =>
        applyGenerationLinks({
          infraDir: options.infraDir,
          revisionId: options.revisionId,
          transport: configurationDataManagerTransport(),
          issuer: options.execution,
          leaseId: options.lease.leaseId,
          signal: options.signal,
        }),
      options.signal,
    );
  } catch (error) {
    let cause = error;
    while (cause instanceof services.ConfigurationGenerationError && cause.cause instanceof Error)
      cause = cause.cause;
    if (cause instanceof GenerationLinkUnknown)
      throw Object.assign(new OpsExecutionFailure("recovery_required", {}), { cause });
    if (cause instanceof GenerationLinkNotApplied && cause.reason === "busy")
      throw Object.assign(new OpsExecutionFailure("busy", {}), { cause });
    throw cause;
  }
}

export function installConfigurationHardlinksRuntime(
  runtime: OpsRuntime,
  options: { infraDir: string },
): void {
  runtime["configuration.hardlinks.apply"] = async (operation, context: OpsExecutionContext) => {
    const lease = context.artifactLease ?? context.ownedTargetLease;
    if (!lease) throw Error("Original hardlink lease required");
    // A stopped coordinator never causes a lifecycle fallback inside this operation.
    if (readGenerationHardlinkPlan(options.infraDir, operation.revisionId).plan.length)
      await assertConfigurationCoordinatorReady(context.signal);
    return applyAgentGenerationLinks({
      infraDir: options.infraDir,
      revisionId: operation.revisionId,
      execution: context.execution,
      lease,
      signal: context.signal,
    });
  };
}
