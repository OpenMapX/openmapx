/** Fixed current credential producer; all writes remain in the existing candidate. */
import type { IntegrationApplyReceipt } from "@openmapx/core/api-contracts";
import { JobObservationPending } from "./admin-job-failure";
import type { JobContext } from "./job-runner";
import { applyTrustedConfigurationWithEvidence } from "./trusted-configuration-producer";
export interface IntegrationCredentialIntent {
  integrationId: string;
  key: string;
  action: "set" | "delete";
  value?: string;
  expectedRevision: string;
  operationKey: string;
  actorId: string;
}
export async function runIntegrationCredentialChange(
  ctx: JobContext,
  input: IntegrationCredentialIntent,
): Promise<IntegrationApplyReceipt> {
  const common = {
    kind: "integration-secret" as const,
    integrationId: input.integrationId,
    key: input.key,
    expectedRevision: input.expectedRevision,
  };
  const evidence = await applyTrustedConfigurationWithEvidence({
    kind: "integrationConfig.apply",
    integrationId: input.integrationId,
    actorId: input.actorId,
    operationKey: input.operationKey,
    ctx,
    signal: ctx.signal,
    overlay: {
      purpose: "integration-secret",
      coordinatorMode: "ensure-running",
      changes: [
        input.action === "set"
          ? { ...common, action: "set", value: input.value ?? "" }
          : { ...common, action: "delete" },
      ],
    },
  });
  if (!evidence.integrationApplication) throw new JobObservationPending("recovery_required");
  return evidence.integrationApplication;
}
