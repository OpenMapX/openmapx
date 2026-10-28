import type { IntegrationApplyReceipt } from "@openmapx/core/api-contracts";
import {
  type CoordinatorMode,
  canonicalJson,
  configurationApplyResultSchema,
  configurationGenerationRevisionSchema,
  type OpsResultFor,
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "@openmapx/core/ops";
import { getAllIntegrations } from "../integration-host";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import { hasRetainedAdminJobOperation, observeRetainedAdminJobOperation } from "./admin-job-ops";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import {
  type ProspectiveConfigurationOverlay,
  persistAndApplyProspectiveConfiguration,
  prepareProspectiveConfiguration,
  retireSettledProspectiveConfiguration,
  type ValidatedConfigurationCandidate,
} from "./prospective-configuration";
import {
  completeTrustedConfigurationApply,
  TrustedConfigurationApplyError,
  type TrustedConfigurationApplyOutcome,
  TrustedConfigurationUpgradeRequired,
} from "./trusted-config-outcome";

type ConfigurationKind =
  | "stack.render"
  | "serviceSelection.apply"
  | "serviceConfig.apply"
  | "integrationConfig.apply"
  | "vault.apply";
export type CapturedIntegrationReloadResult = {
  message: string;
  reloaded: number;
  enabled: number;
};

export interface ApplyTrustedConfigurationOptions {
  kind: ConfigurationKind;
  operationKey: string;
  serviceId?: string;
  integrationId?: string;
  selectedRoots?: string[];
  signal?: AbortSignal;
  ctx?: JobContext;
  actorId?: string;
  coordinatorMode?: CoordinatorMode;
  /** Current service-credential producer's fixed continuation; never a render-only fallback. */
  followUp?: "service-apply";
  expectedCurrentRevisionId?: string | null;
  overlay?: ProspectiveConfigurationOverlay;
  candidate?: ValidatedConfigurationCandidate;
  /** Internal compensation must still equal the strictly acquired desired snapshot. */
  snapshot?: TrustedConfigurationPayload;
}

export { buildConfigurationInput } from "./configuration-input";

/**
 * Hand the database's configuration to the ops-agent, which renders it with
 * the operator's selection (or `selectedRoots`, which become it) and makes it
 * the applied generation. The registry follows what was applied.
 */
export async function applyTrustedConfiguration(
  options: ApplyTrustedConfigurationOptions,
): Promise<{
  revisionId: string;
  enabledServiceIds: string[];
  jobId?: string;
  integrationReload?: CapturedIntegrationReloadResult;
  integrationApplication?: IntegrationApplyReceipt;
}> {
  return completeTrustedConfigurationApplication(
    options,
    await applyTrustedConfigurationWithEvidence(options),
  );
}

/** Internal evidence for scoped compensation. Payload may contain secrets; never serialize it. */
export async function applyTrustedConfigurationWithEvidence(
  options: ApplyTrustedConfigurationOptions,
): Promise<{
  payload?: TrustedConfigurationPayload;
  previousApplied?: OpsResultFor<"configuration.inspect">;
  outcome: TrustedConfigurationApplyOutcome;
  jobId?: string;
  integrationReload?: CapturedIntegrationReloadResult;
  integrationApplication?: IntegrationApplyReceipt;
}> {
  if (options.ctx && hasRetainedAdminJobOperation(options.ctx, options.operationKey)) {
    const outcome = configurationApplyResultSchema.parse(
      await observeRetainedAdminJobOperation(options.ctx, options.operationKey),
    );
    const retained = (
      options.ctx.checkpointResult?._configurationOutcomes as
        | Record<string, TrustedConfigurationApplyOutcome>
        | undefined
    )?.[options.operationKey];
    if (!retained) {
      await options.ctx.checkpoint({ ...options.ctx.checkpointResult, configuration: outcome });
      throw new JobObservationPending("recovery_required");
    }
    return { outcome: retained };
  }
  if (!options.ctx) throw new TrustedConfigurationUpgradeRequired();
  const ctx = options.ctx;
  const coordinatorMode = options.coordinatorMode ?? "ensure-running";
  const actorId = options.actorId ?? ctx.jobId;
  const overlay =
    options.overlay ??
    (options.kind === "serviceSelection.apply" && options.selectedRoots
      ? {
          purpose: "selection" as const,
          coordinatorMode,
          changes: [{ kind: "selection" as const, selectedRoots: options.selectedRoots }],
        }
      : options.kind === "stack.render" && options.selectedRoots === undefined
        ? { purpose: "render" as const, coordinatorMode, changes: [] }
        : undefined);
  if (!overlay && !options.candidate)
    return {
      outcome: {
        outcome: "not_committed",
        reason: "failed",
        cleanupFailed: false,
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      },
    };
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      {
        actorId,
        operationKey: options.operationKey,
        integrationIds:
          overlay?.changes.flatMap((change) =>
            "integrationId" in change ? [change.integrationId] : [],
          ) ?? [],
        signal: options.signal ?? ctx.signal,
      },
      async () => {
        const previousApplied = await executeAndWait(
          createApiOpsClient(),
          { kind: "configuration.inspect" },
          createDurableOpsKey("configuration.inspect", options.operationKey),
          { signal: options.signal ?? ctx.signal },
        );
        const expectedCurrentRevisionId = Object.hasOwn(options, "expectedCurrentRevisionId")
          ? options.expectedCurrentRevisionId!
          : previousApplied.revisionId;
        const candidate =
          options.candidate ??
          (await prepareProspectiveConfiguration({
            actorId,
            operationKey: options.operationKey,
            expectedCurrentRevisionId,
            overlay: overlay!,
            signal: options.signal ?? ctx.signal,
            followUp: options.followUp,
          }));
        const { validatedConfigurationCandidateState } = await import(
          "./prospective-configuration"
        );
        const candidateState = validatedConfigurationCandidateState(candidate),
          payload = candidateState.payload;
        const operation = candidateState.sealed.operation;
        if (
          operation.kind !== options.kind ||
          ("serviceId" in operation &&
            options.serviceId &&
            options.serviceId !== operation.serviceId) ||
          ("integrationId" in operation &&
            options.integrationId &&
            options.integrationId !== operation.integrationId) ||
          (options.selectedRoots &&
            canonicalJson(options.selectedRoots) !== canonicalJson(payload.selectedRoots))
        )
          throw Error("Configuration candidate intent conflict");
        if (options.followUp && candidateState.record.apiFollowUp !== options.followUp)
          throw Error("Configuration continuation intent conflict");
        if (options.snapshot && canonicalJson(options.snapshot) !== canonicalJson(payload))
          throw new Error("Strict compensation requires current owned desired rows");
        const receipt = await persistAndApplyProspectiveConfiguration(candidate, {
          coordinatorMode,
          signal: options.signal ?? ctx.signal,
        });
        if (
          !candidateState.record.maintenanceId &&
          candidateState.record.apiFollowUp === "service-apply" &&
          completeTrustedConfigurationApply(receipt.application)
        ) {
          const { completeProspectiveServiceCredential } = await import(
            "./prospective-configuration"
          );
          await completeProspectiveServiceCredential(candidate);
        }
        if (
          candidateState.overlay.purpose === "integration-secret" &&
          candidateState.overlay.changes.some(
            (change) => change.kind === "integration-secret" && change.expectedRevision,
          ) &&
          completeTrustedConfigurationApply(receipt.application)
        ) {
          const { completeIntegrationActivation } = await import("./prospective-configuration");
          const integrationApplication = await completeIntegrationActivation(
            candidate,
            receipt.application,
          );
          return { payload, previousApplied, outcome: receipt.application, integrationApplication };
        }
        if (
          candidateState.record.apiFollowUp === "integration-reload" &&
          completeTrustedConfigurationApply(receipt.application)
        ) {
          await ctx.checkpoint({
            ...ctx.checkpointResult,
            integrationReload: {
              state: "attempted",
              candidateId: candidate.candidateId,
              revisionId: candidate.revisionId,
            },
          });
          try {
            const { reloadProspectiveIntegrations } = await import("./prospective-configuration");
            const integrationReload = await reloadProspectiveIntegrations(candidate);
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              _configurationCandidate: {
                ...(ctx.checkpointResult?._configurationCandidate as Record<string, unknown>),
                phase: "settled",
              },
              integrationReload: {
                state: "complete",
                candidateId: candidate.candidateId,
                revisionId: candidate.revisionId,
                result: integrationReload,
              },
            });
            await retireSettledProspectiveConfiguration(candidate);
            return { payload, previousApplied, outcome: receipt.application, integrationReload };
          } catch {
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              _configurationCandidate: {
                ...(ctx.checkpointResult?._configurationCandidate as Record<string, unknown>),
                phase: "unknown",
              },
              integrationReload: {
                state: "failed",
                candidateId: candidate.candidateId,
                revisionId: candidate.revisionId,
              },
            });
            throw new AdminJobFailure("Integration reload did not complete", {
              configuration: receipt.application,
              integrationReload: { state: "failed" },
            });
          }
        }
        return { payload, previousApplied, outcome: receipt.application };
      },
    ),
  );
}

/** Full-snapshot compensation; compare the applied generation, NOT the manifest authority. */
export async function applyTrustedConfigurationSnapshot(options: {
  payload: TrustedConfigurationPayload;
  expectedCurrentRevisionId: string | null;
  operationKey: string;
  signal?: AbortSignal;
  ctx?: JobContext;
}): Promise<TrustedConfigurationApplyOutcome> {
  if (
    !configurationGenerationRevisionSchema.nullable().safeParse(options.expectedCurrentRevisionId)
      .success
  ) {
    return {
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    };
  }
  return applySnapshot(
    {
      kind: "stack.render",
      operationKey: options.operationKey,
      signal: options.signal,
      ctx: options.ctx,
    },
    options.payload,
    options.expectedCurrentRevisionId,
  );
}

async function applySnapshot(
  options: ApplyTrustedConfigurationOptions,
  input: TrustedConfigurationPayload,
  expectedCurrentRevisionId: string | null,
): Promise<TrustedConfigurationApplyOutcome> {
  if (!options.ctx) throw new TrustedConfigurationUpgradeRequired();
  return (
    await applyTrustedConfigurationWithEvidence({
      ...options,
      expectedCurrentRevisionId,
      snapshot: trustedConfigurationPayloadSchema.parse(input),
    })
  ).outcome;
}

/** The config schema of every loaded integration, by id. */
export function integrationSchemas(): Map<string, Record<string, unknown>> {
  return new Map(
    getAllIntegrations().map((integration) => [
      integration.id,
      (integration.manifest.configSchema ?? {}) as Record<string, unknown>,
    ]),
  );
}

/** Safe result projection only; this function constructs no candidate/job/grant. */
export function completeTrustedConfigurationApplication(
  options: ApplyTrustedConfigurationOptions,
  evidence: Awaited<ReturnType<typeof applyTrustedConfigurationWithEvidence>>,
) {
  const { outcome, jobId, integrationReload } = evidence;
  if (options.ctx && outcome.outcome === "unknown") throw new JobObservationPending("transport");
  if (
    outcome.outcome !== "committed" ||
    outcome.followUp !== "complete" ||
    outcome.cleanupFailed ||
    outcome.publisherCleanupFailed ||
    outcome.registryUpdateFailed
  )
    if (options.ctx)
      throw new AdminJobFailure("Configuration did not complete", { configuration: outcome });
    else throw new TrustedConfigurationApplyError(outcome);
  return {
    revisionId: outcome.revisionId,
    enabledServiceIds: outcome.enabledServiceIds,
    ...(jobId ? { jobId } : {}),
    ...(integrationReload ? { integrationReload } : {}),
  };
}
