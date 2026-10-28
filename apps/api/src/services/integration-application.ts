/** Fixed binding coordinator in the existing candidate/writer transaction. */
import type { IntegrationApplyReceipt } from "@openmapx/core/api-contracts";
import { JobObservationPending } from "./admin-job-failure";
import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
  withConfigurationCommitParticipant,
} from "./administrative-configuration-writer";
import {
  type IntegrationBindingInput,
  integrationBindingParticipation,
  prepareIntegrationBindingChange,
} from "./integration-binding-participant";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import {
  completeBindingActivation,
  persistAndApplyProspectiveConfiguration,
  prepareProspectiveConfiguration,
} from "./prospective-configuration";
import { completeTrustedConfigurationApply } from "./trusted-config-outcome";

export async function runBindingChange(
  ctx: JobContext,
  options: { input: IntegrationBindingInput; actorId: string; operationKey: string },
): Promise<IntegrationApplyReceipt> {
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      {
        actorId: options.actorId,
        operationKey: options.operationKey,
        integrationIds: [options.input.integrationId],
        signal: ctx.signal,
      },
      async (writer) => {
        const intent = await prepareIntegrationBindingChange(options.input, writer),
          scope = integrationBindingParticipation(intent, writer);
        return withConfigurationCommitParticipant(writer, scope.participant, async () => {
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
            overlay: scope.overlay,
            signal: ctx.signal,
          });
          const receipt = await persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "ensure-running",
            signal: ctx.signal,
          });
          if (!completeTrustedConfigurationApply(receipt.application))
            throw new JobObservationPending("recovery_required");
          return completeBindingActivation(candidate, receipt.application);
        });
      },
    ),
  );
}
