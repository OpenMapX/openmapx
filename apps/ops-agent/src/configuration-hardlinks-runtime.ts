import {
  executeOwnedGenerationHardlinks,
  type GenerationHardlinksOwnerPlan,
  planGenerationHardlinksOwner,
  readGenerationHardlinksOwnerPlan,
} from "@openmapx/core/build-artifacts";
import {
  createDataManagerTransport,
  DataExecutionObservationPending,
  getStatus,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import type { ExecutionRef, OpsOperation } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { OpsExecutionFailure, type OpsRuntime } from "./runtime";

const sources = new WeakMap<OpsRuntime, { infraDir: string }>();
/** The production factory's fixed source; callers cannot inject a handler or a plan. */
export function prepareConfigurationHardlinksAdmission(
  runtime: OpsRuntime,
  parent: ExecutionRef,
  operation: Extract<OpsOperation, { kind: "configuration.hardlinks.apply" }>,
  serviceIds: readonly string[],
): GenerationHardlinksOwnerPlan {
  const source = sources.get(runtime);
  if (!source) throw Error("Production hardlink source unavailable");
  return planGenerationHardlinksOwner({
    ...source,
    parent,
    revisionId: operation.revisionId,
    coordinatorMode: operation.coordinatorMode,
    serviceIds,
  });
}
export function configurationDataManagerTransport() {
  return createDataManagerTransport({
    baseUrl: process.env.DATA_MANAGER_URL?.trim() || "http://data-manager:4000",
    authToken: process.env.DATA_MANAGER_AUTH_TOKEN?.trim(),
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
export function installConfigurationHardlinksRuntime(
  runtime: OpsRuntime,
  options: { infraDir: string },
): void {
  sources.set(runtime, options);
  runtime["configuration.hardlinks.apply"] = async (operation, context) => {
    const authority = context.controlAuthority,
      lease = context.artifactLease ?? context.ownedTargetLease;
    if (!authority || !lease) throw Error("Original hardlink root authority required");
    const plan = readGenerationHardlinksOwnerPlan(authority);
    if (
      plan.revisionId !== operation.revisionId ||
      plan.coordinatorMode !== operation.coordinatorMode
    )
      throw Error("Hardlink owner binding conflict");
    // A stopped coordinator never causes a lifecycle fallback inside this owner.
    if (plan.plan.plan.length) await assertConfigurationCoordinatorReady(context.signal);
    try {
      return await services.withConfigurationGenerationWriter(
        options.infraDir,
        async () => {
          if (plan.plan.plan.length) await assertConfigurationCoordinatorReady(context.signal);
          return executeOwnedGenerationHardlinks({
            authority,
            lease,
            ...options,
            transport: configurationDataManagerTransport(),
            signal: context.signal,
          });
        },
        context.signal,
      );
    } catch (error) {
      let cause = error;
      while (cause instanceof services.ConfigurationGenerationError && cause.cause instanceof Error)
        cause = cause.cause;
      if (cause instanceof DataExecutionObservationPending)
        throw new OpsExecutionFailure("recovery_required", {});
      throw error;
    }
  };
}
