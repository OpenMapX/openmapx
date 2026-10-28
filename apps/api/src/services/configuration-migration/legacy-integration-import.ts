/** Existing ordinary integration batch adapter; its sole issuer is the
 * adjacent built-in intent module, with no future workflow registration. */
import type {
  AdminIntegrationConfigImported,
  AdminIntegrationImportFailure,
} from "@openmapx/core/api-contracts";
import { ConfigurationPrerequisiteFailure, JobObservationPending } from "../admin-job-failure";
import {
  type AdministrativeConfigurationWriter,
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
  withConfigurationCommitParticipant,
} from "../administrative-configuration-writer";
import { completeConfigurationApply, prepareIntegrationImport } from "../integration-config-import";
import type { JobContext } from "../job-runner";
import {
  createApiOpsClient,
  createDurableOpsKey,
  executeAndWait,
  OpsObservationPending,
} from "../ops-client";
import {
  discardUnadmittedTrustedConfigurationCandidate,
  type ProspectiveConfigurationOverlay,
  persistAndApplyProspectiveConfiguration,
  prepareProspectiveConfiguration,
  reloadProspectiveIntegrations,
  retireSettledProspectiveConfiguration,
} from "../prospective-configuration";
import {
  type LegacyIntegrationImportIntent,
  legacyIntegrationImportParticipation,
  prepareLegacyIntegrationImport,
} from "./legacy-integration-import-intent";

export {
  isLegacyIntegrationImportParticipant,
  type LegacyIntegrationImportIntent,
  prepareLegacyIntegrationImport,
  retainedLegacyIntegrationImportIntent,
} from "./legacy-integration-import-intent";

export function withLegacyIntegrationImport<T>(
  intent: LegacyIntegrationImportIntent,
  writer: AdministrativeConfigurationWriter,
  run: (overlay: ProspectiveConfigurationOverlay) => Promise<T>,
): Promise<T> {
  const state = legacyIntegrationImportParticipation(intent, writer);
  return withConfigurationCommitParticipant(writer, state.participant, () => run(state.overlay));
}

export async function runLegacyIntegrationImport(
  ctx: JobContext,
  options: { body: unknown; actorId: string; operationKey: string },
): Promise<AdminIntegrationConfigImported | AdminIntegrationImportFailure> {
  // Validation here determines only the finite lock set. The constructor repeats
  // it from its own strict registry/schema observation before issuing authority.
  const { getAllIntegrations } = await import("../../integration-host");
  const entries = prepareIntegrationImport(
    options.body,
    new Map(
      getAllIntegrations().map((i) => [
        i.id,
        i.manifest.configSchema as Record<string, unknown> | undefined,
      ]),
    ),
  );
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      {
        actorId: options.actorId,
        operationKey: options.operationKey,
        integrationIds: entries.map((e) => e.integrationId),
        signal: ctx.signal,
      },
      async (writer) => {
        const failure = {
          ok: false as const,
          error: "Integration import failed" as const,
          recovery: "reconciliation_required" as const,
        };
        const progress = { phase: "persistence" as "persistence" | "apply" | "reload" };
        let receipt:
          | Awaited<ReturnType<typeof persistAndApplyProspectiveConfiguration>>
          | undefined;
        try {
          const intent = await prepareLegacyIntegrationImport({ integrations: entries }, writer);
          if (!intent.changedIntegrationIds.length) {
            // A no-op is still a managed write request. Use the ordinary
            // strict render preflight ONLY for read-only eligibility; this
            // candidate is never persisted/applied or a migration participant.
            const current = await executeAndWait(
              createApiOpsClient(),
              { kind: "configuration.inspect" },
              createDurableOpsKey("configuration.inspect", options.operationKey),
              { signal: ctx.signal },
            );
            const inert = await prepareProspectiveConfiguration({
              actorId: options.actorId,
              operationKey: options.operationKey,
              expectedCurrentRevisionId: current.revisionId,
              overlay: { purpose: "render", coordinatorMode: "ensure-running", changes: [] },
              signal: ctx.signal,
            });
            await discardUnadmittedTrustedConfigurationCandidate(inert);
            return {
              ok: true as const,
              imported: 0,
              skipped: [...intent.integrationIds],
              message: "No configuration changes",
              reloaded: 0,
              enabled: getAllIntegrations().filter((i) => i.enabled).length,
            };
          }
          return await withLegacyIntegrationImport(intent, writer, async (overlay) => {
            const current = await executeAndWait(
              createApiOpsClient(),
              { kind: "configuration.inspect" },
              createDurableOpsKey("configuration.inspect", options.operationKey),
              { signal: ctx.signal },
            );
            const candidate = await prepareProspectiveConfiguration({
              actorId: options.actorId,
              operationKey: options.operationKey,
              expectedCurrentRevisionId: current.revisionId,
              overlay,
              signal: ctx.signal,
            });
            progress.phase = "apply";
            receipt = await persistAndApplyProspectiveConfiguration(candidate, {
              coordinatorMode: "ensure-running",
              signal: ctx.signal,
            });
            if (!completeConfigurationApply(receipt.application))
              return {
                ...failure,
                phase: progress.phase,
                database:
                  receipt.saved === "unknown"
                    ? ("unknown" as const)
                    : receipt.saved === "conflict"
                      ? ("conflict" as const)
                      : ("retained" as const),
                runtime: "unchanged" as const,
                apply: receipt.application,
              };
            progress.phase = "reload";
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              integrationReload: {
                state: "attempted",
                candidateId: candidate.candidateId,
                revisionId: candidate.revisionId,
              },
            });
            const reloaded = await reloadProspectiveIntegrations(candidate);
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
                result: reloaded,
              },
            });
            await retireSettledProspectiveConfiguration(candidate);
            return {
              ok: true as const,
              imported: intent.changedIntegrationIds.length,
              skipped: intent.integrationIds.filter(
                (id) => !intent.changedIntegrationIds.includes(id),
              ),
              ...reloaded,
            };
          });
        } catch (error) {
          if (
            error instanceof JobObservationPending ||
            error instanceof OpsObservationPending ||
            error instanceof ConfigurationPrerequisiteFailure
          )
            throw error;
          if (progress.phase === "reload")
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              _configurationCandidate: {
                ...(ctx.checkpointResult?._configurationCandidate as Record<string, unknown>),
                phase: "unknown",
              },
              integrationReload: {
                ...(ctx.checkpointResult?.integrationReload as Record<string, unknown>),
                state: "unknown",
              },
            });
          return {
            ...failure,
            phase: progress.phase,
            database:
              progress.phase === "persistence" ||
              receipt?.saved === "committed" ||
              receipt?.saved === "unchanged"
                ? "retained"
                : "unknown",
            runtime: progress.phase === "reload" ? "unknown" : "unchanged",
            ...(receipt ? { apply: receipt.application } : {}),
          };
        }
      },
    ),
  );
}
