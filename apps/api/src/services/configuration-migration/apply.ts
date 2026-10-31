import {
  type ConfigurationMigrationDocument,
  configurationMigrationDocumentSchema,
} from "../../../../../packages/core/src/api/contracts/integration-admin/configuration-migration";
import { authPolicyKeys } from "../../account/auth-policy";
import { JobObservationPending } from "../admin-job-failure";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "../administrative-configuration-writer-owner";
import { withConfigurationCommitParticipant } from "../configuration-commit-participant";
import type { JobContext } from "../job-runner";
import {
  discardStagedMigrationPreview,
  persistAndApplyProspectiveConfiguration,
  prepareProspectiveConfiguration,
  reloadProspectiveIntegrations,
  retireSettledProspectiveConfiguration,
} from "../prospective-configuration";
import { completeTrustedConfigurationApply } from "../trusted-config-outcome";
import type { CredentialPlan } from "./credential-preview";
import { type MigrationProof, prepareStagedMigrationParticipant } from "./participant";
import { type MigrationPlan, migrationPlanPreview, previewConfigurationMigration } from "./preview";
import { MigrationConflict, readMigrationStage } from "./staging";

export type MigrationResult = {
  operationId: string;
  outcome: "applied" | "partial" | "failed" | "unknown";
  steps: Array<{ scope: string; id: string; status: "applied" | "failed" | "pending" | "unknown" }>;
};
export type MigrationApplicationInput = {
  actorId: string;
  operationKey: string;
  previewId: string;
  fingerprint: string;
  kind: "migration" | "credentials";
  expectedCurrentRevisionId?: string | null;
  proof?: MigrationProof;
  platformAuthorization?: import("./participant").MigrationPlatformAuthorization;
};
export async function runConfigurationMigrationPreview(
  ctx: JobContext,
  input: { actorId: string; operationKey: string; document: ConfigurationMigrationDocument },
) {
  const document = configurationMigrationDocumentSchema.parse(input.document),
    integrationIds = [
      ...new Set([
        ...document.integrations.map((i) => i.integrationId),
        ...document.bindings.map((b) => b.integrationId),
      ]),
    ];
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { ...input, integrationIds, signal: ctx.signal },
      async (writer) => {
        const preview = await previewConfigurationMigration(document, input.actorId, writer);
        if (!preview.denials.length) {
          const stage = await readMigrationStage({
              actorId: input.actorId,
              previewId: preview.previewId,
              fingerprint: preview.fingerprint,
              kind: "migration",
            }),
            scope = await prepareStagedMigrationParticipant({ stage, writer, mode: "preview" });
          await withConfigurationCommitParticipant(writer, scope.participant, async () => {
            const candidate = await prepareProspectiveConfiguration({
              actorId: input.actorId,
              operationKey: input.operationKey,
              expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
              overlay: scope.overlay,
              signal: ctx.signal,
            });
            await discardStagedMigrationPreview(candidate);
          });
        }
        return preview;
      },
    ),
  );
}
export async function runConfigurationMigration(ctx: JobContext, input: MigrationApplicationInput) {
  const stage = await readMigrationStage(input),
    plan = stage.value as MigrationPlan | CredentialPlan;
  if (
    input.expectedCurrentRevisionId !== undefined &&
    input.expectedCurrentRevisionId !== plan.expectedCurrentRevisionId
  )
    throw new MigrationConflict();
  const integrationIds = [
    ...new Set(
      plan.overlay.changes.flatMap((c) => ("integrationId" in c ? [c.integrationId] : [])),
    ),
  ];
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      { ...input, integrationIds, signal: ctx.signal },
      async (writer) => {
        const scope = await prepareStagedMigrationParticipant({
          stage,
          writer,
          mode: "apply",
          proof: input.proof,
          platformAuthorization: input.platformAuthorization,
        });
        return withConfigurationCommitParticipant(writer, scope.participant, async () => {
          const steps: MigrationResult["steps"] = scope.overlay.changes.map((c) => ({
            scope: c.kind,
            id:
              "integrationId" in c ? c.integrationId : "serviceId" in c ? c.serviceId : "platform",
            status: "pending",
          }));
          if (stage.kind === "migration")
            for (const key of Object.keys((plan as MigrationPlan).settings))
              steps.push({
                scope: authPolicyKeys.includes(key) ? "pending-auth" : "settings",
                id: key,
                status: "pending",
              });
          await ctx.checkpoint({
            ...ctx.checkpointResult,
            _migrationSteps: steps,
            _migrationStage: {
              id: stage.previewId,
              kind: stage.kind,
              fingerprint: stage.fingerprint,
            },
          });
          const candidate = await prepareProspectiveConfiguration({
            actorId: input.actorId,
            operationKey: input.operationKey,
            expectedCurrentRevisionId: plan.expectedCurrentRevisionId,
            overlay: scope.overlay,
            signal: ctx.signal,
          });
          const receipt = await persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: scope.overlay.coordinatorMode,
            signal: ctx.signal,
          });
          let outcome: MigrationResult["outcome"];
          if (completeTrustedConfigurationApply(receipt.application)) {
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              integrationReload: {
                state: "attempted",
                candidateId: candidate.candidateId,
                revisionId: candidate.revisionId,
              },
            });
            let failurePhase: "reload" | "retirement" = "reload";
            try {
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
              for (const step of steps)
                if (
                  step.scope !== "pending-auth" &&
                  !(step.scope.startsWith("service-") && plan.pendingServiceIds?.includes(step.id))
                )
                  step.status = "applied";
              outcome = steps.some((s) => s.status === "pending") ? "partial" : "applied";
              failurePhase = "retirement";
              await retireSettledProspectiveConfiguration(candidate);
            } catch (error) {
              const known = new Set([
                "Integration source changed",
                "Configuration reload unavailable",
                "Original delivered maintenance completion required",
                "Actual original maintenance closure required before cleanup",
                "Original platform completion required",
                "Committed configuration candidate required",
              ]);
              await ctx.checkpoint({
                ...ctx.checkpointResult,
                _migrationFailure: {
                  phase: failurePhase,
                  reason:
                    error instanceof Error && known.has(error.message)
                      ? error.message
                      : "activation_or_retirement_unknown",
                },
              });
              for (const step of steps) if (step.scope !== "pending-auth") step.status = "unknown";
              outcome = "unknown";
            }
          } else {
            outcome =
              receipt.application.outcome === "unknown"
                ? "unknown"
                : receipt.saved === "committed"
                  ? "partial"
                  : "failed";
            for (const step of steps)
              step.status =
                outcome === "unknown" ? "unknown" : outcome === "failed" ? "failed" : "pending";
          }
          const value: MigrationResult = { operationId: ctx.jobId, outcome, steps };
          if (outcome === "unknown") {
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              migration: value,
              configuration: receipt.application,
            });
            throw new JobObservationPending("recovery_required");
          }
          return {
            value,
            result: {
              ...ctx.checkpointResult,
              migration: value,
              configuration: receipt.application,
            },
            failed:
              outcome === "failed" ||
              (outcome === "partial" && !completeTrustedConfigurationApply(receipt.application)),
          };
        });
      },
    ),
  );
}
