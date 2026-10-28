/** Fixed actual writer/job step producer. Pure decoding is separate so ordinary
 * managed-operation readers do not load configuration/auth runtime services. */
import {
  type ConfigurationMaintenanceStep,
  canonicalJson,
  configurationMaintenanceReceiptSchema,
  type OpsOperation,
} from "@openmapx/core/ops";
import * as schema from "../db/schema";
import type { ApiPreparedRoot } from "./admin-job-parent";
import { jobOwnership } from "./admin-job-state";
import {
  administrativeConfigurationState,
  currentAdministrativeConfigurationWriter,
  withConfigurationWriteTransaction,
} from "./administrative-configuration-writer";
import {
  assertConfigurationSavedRows,
  configurationMaintenanceDecisionCheckpointSchema,
} from "./configuration-maintenance-decision";
import { descriptor, observedStep, records } from "./configuration-maintenance-step-records";
import type { JobContext } from "./job-runner";
/** Called for a non-root managed key before its atomic admission checkpoint.
 * Parsed metadata or a caller preparedRoot cannot bypass the real writer/job. */
export async function assertOwnedConfigurationMaintenanceStep(
  job: JobContext,
  operation: OpsOperation,
  operationKey: string,
  root: ApiPreparedRoot,
): Promise<void> {
  const owner = administrativeConfigurationState(currentAdministrativeConfigurationWriter());
  if (owner.job !== job || !job.execution) throw Error("Actual maintenance job writer required");
  await withConfigurationWriteTransaction(owner.writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined;
    if (!result) throw Error("Actual maintenance job checkpoint required");
    const { source, receipt } = observedStep(result, operationKey, operation),
      decision = configurationMaintenanceDecisionCheckpointSchema.parse(
        result._configurationMaintenanceDecision,
      );
    if (
      receipt.apiJobId !== job.jobId ||
      decision.operation.decision !== "continue" ||
      decision.operation.decisionId !== receipt.decision?.decisionId ||
      decision.attempt !== "attempted" ||
      root.operationKey !== source.operationKey ||
      root.requestedDeadlineAt !== source.requestedDeadlineAt ||
      canonicalJson(root.parent) !== canonicalJson(source.parent)
    )
      throw Error("Actual authorized frozen maintenance step required");
  });
}
export async function prepareOwnedConfigurationMaintenanceStep(
  ordinal: number,
  candidateId: string,
  maintenanceId: string,
): Promise<{ step: ConfigurationMaintenanceStep; root: ApiPreparedRoot }> {
  const owner = administrativeConfigurationState(currentAdministrativeConfigurationWriter()),
    { job } = owner,
    { readProjection } = await import("./admin-job-projection");
  let committed: Record<string, unknown> | undefined;
  const prepared = await withConfigurationWriteTransaction(owner.writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      remote = result?._configurationMaintenance as Record<string, unknown> | undefined,
      receipt = configurationMaintenanceReceiptSchema.parse(remote?.receipt),
      decision = configurationMaintenanceDecisionCheckpointSchema.parse(
        result?._configurationMaintenanceDecision,
      ),
      step = receipt.steps[ordinal];
    if (
      !result ||
      receipt.binding.candidateId !== candidateId ||
      receipt.binding.maintenanceId !== maintenanceId ||
      !Number.isInteger(ordinal) ||
      !step ||
      receipt.apiJobId !== job.jobId ||
      !receipt.decision ||
      receipt.decision.decision !== "continue" ||
      decision.operation.decisionId !== receipt.decision.decisionId ||
      decision.operation.prepareOperationKey !== receipt.prepare.operationKey ||
      decision.operation.planDigest !== receipt.planDigest ||
      decision.attempt !== "attempted" ||
      !decision.delivery
    )
      throw Error("Actual committed maintenance decision required");
    const projection = readProjection(result),
      control = projection.operations[decision.delivery.root.operationKey],
      delivered = control?.receiptDelivery;
    if (
      !control?.terminal ||
      delivered?.state !== "confirmed" ||
      delivered.terminalReceipt.state !== "succeeded" ||
      configurationMaintenanceReceiptSchema.parse(delivered.terminalReceipt.result).decision
        ?.decisionId !== decision.operation.decisionId
    )
      throw Error("Actual delivered maintenance decision required");
    const previous =
        result._configurationMaintenanceSteps === undefined
          ? {}
          : records.parse(result._configurationMaintenanceSteps),
      existing = previous[String(ordinal)];
    if (existing) {
      const observed = observedStep(result, step.operationKey, step.operation);
      committed = result;
      return {
        step,
        root: {
          operationKey: observed.source.operationKey,
          requestedDeadlineAt: observed.source.requestedDeadlineAt,
          parent: observed.source.parent,
        },
      };
    }
    await assertConfigurationSavedRows(tx, decision.rowVersions);
    for (const index of step.prerequisites) {
      const prior = receipt.steps[index]!,
        actual = projection.operations[prior.operationKey];
      if (
        !actual?.terminal ||
        actual.errorClass ||
        actual.kind !== prior.operation.kind ||
        canonicalJson(actual.operation) !== canonicalJson(prior.operation) ||
        actual.receiptDelivery?.state !== "confirmed" ||
        actual.receiptDelivery.terminalReceipt.state !== "succeeded"
      )
        throw Error("Original frozen maintenance prerequisite is unresolved");
      if (
        prior.phase === "configuration-commit" &&
        (!actual.result ||
          typeof actual.result !== "object" ||
          (actual.result as { outcome?: string }).outcome !== "committed" ||
          (actual.result as { revisionId?: string }).revisionId !== receipt.binding.revisionId)
      )
        throw Error("Original maintenance generation is not committed");
    }
    const source = descriptor.parse({
      ordinal,
      operationKey: step.operationKey,
      requestedDeadlineAt: receipt.prepare.deadlineAt,
      parent: {
        operationKey: receipt.parentOperationKey,
        fingerprint: receipt.parentFingerprint,
        deadlineAt: receipt.parentDeadlineAt,
      },
    });
    committed = {
      ...result,
      _configurationMaintenanceSteps: records.parse({ ...previous, [String(ordinal)]: source }),
    };
    const saved = await tx
      .update(schema.adminJob)
      .set({ result: committed })
      .where(jobOwnership(job.jobId, job.execution))
      .returning({ id: schema.adminJob.id });
    if (saved.length !== 1) throw Error("Original maintenance job ownership changed");
    return {
      step,
      root: {
        operationKey: source.operationKey,
        requestedDeadlineAt: source.requestedDeadlineAt,
        parent: source.parent,
      },
    };
  });
  if (!committed) throw Error("Original maintenance step checkpoint unavailable");
  job.checkpointResult = committed;
  return prepared;
}
