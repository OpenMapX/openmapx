/** Closed original-root API step preparation. Structural parsing is only data
 * validation; fresh submission additionally reads the actual owned DB row. */

import { controlChildOperationKey } from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  configurationMaintenanceReceiptSchema,
  type OpsOperation,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { z } from "zod";
import { apiJobChildAttemptSchema } from "./admin-job-parent";

const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  epoch = z.number().int().nonnegative().safe();
const parent = z.strictObject({
  operationKey: key,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  deadlineAt: epoch,
});
export const descriptor = z.strictObject({
  ordinal: z.number().int().min(0).max(31),
  operationKey: key,
  requestedDeadlineAt: epoch,
  parent,
});
export const records = z
  .record(z.string().regex(/^(?:[0-9]|[12][0-9]|3[01])$/), descriptor)
  .refine((value) => Object.keys(value).length <= 32);
export function observedStep(
  result: Record<string, unknown>,
  operationKey: string,
  operation: OpsOperation,
) {
  const remote = result._configurationMaintenance as Record<string, unknown> | undefined,
    receipt = configurationMaintenanceReceiptSchema.parse(remote?.receipt),
    retained = records.parse(result._configurationMaintenanceSteps),
    source = Object.values(retained).find((value) => value.operationKey === operationKey),
    step = source && receipt.steps[source.ordinal],
    candidate = result._configurationCandidate as Record<string, unknown> | undefined;
  if (
    !source ||
    !step ||
    String(source.ordinal) !== Object.keys(retained).find((index) => retained[index] === source) ||
    !receipt.decision ||
    receipt.decision.decision !== "continue" ||
    step.operationKey !== operationKey ||
    operationKey !==
      controlChildOperationKey(receipt.prepare.operationKey, step.phase, step.ordinal) ||
    step.operationFingerprint !== opsOperationFingerprint(operation) ||
    canonicalJson(step.operation) !== canonicalJson(operation) ||
    source.requestedDeadlineAt !== receipt.prepare.deadlineAt ||
    canonicalJson(source.parent) !==
      canonicalJson({
        operationKey: receipt.parentOperationKey,
        fingerprint: receipt.parentFingerprint,
        deadlineAt: receipt.parentDeadlineAt,
      }) ||
    candidate?.candidateId !== receipt.binding.candidateId ||
    candidate.maintenanceId !== receipt.binding.maintenanceId ||
    candidate.prepareOperationKey !== receipt.prepare.operationKey ||
    candidate.revisionId !== receipt.binding.revisionId
  )
    throw Error("Original frozen maintenance step checkpoint required");
  return { receipt, source, step };
}
/** One completed DM ordinal in the existing batch. Observation only: fresh
 * frozen-step constructors deliberately continue to call observedStep above. */
export const completedCoordinatorMaintenanceSchema = z.strictObject({
  version: z.literal(1),
  originalOrdinal: z.number().int().min(0).max(255),
  candidate: z.strictObject({
    candidateId: z.uuid(),
    maintenanceId: z.uuid(),
    prepareOperationKey: key,
    revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
    operationKey: key,
    phase: z.literal("settled"),
  }),
  receipt: configurationMaintenanceReceiptSchema,
  steps: records,
  settlementOperationKey: key,
});
export function completedCoordinatorMaintenance(result: Record<string, unknown>) {
  const archived = completedCoordinatorMaintenanceSchema.parse(
      result._completedCoordinatorMaintenance,
    ),
    receipt = archived.receipt,
    operations = (
      result.opsProjection as
        | {
            operations?: Record<
              string,
              {
                terminal?: boolean;
                phase?: string;
                operation?: OpsOperation;
                result?: unknown;
                receiptDelivery?: {
                  state?: string;
                  terminalReceipt?: { state?: string; result?: unknown };
                };
              }
            >;
          }
        | undefined
    )?.operations,
    settle = operations?.[archived.settlementOperationKey];
  if (
    receipt.state !== "settled" ||
    receipt.dmFence?.state !== "settled" ||
    receipt.decision?.decision !== "continue" ||
    receipt.generation !== "committed" ||
    receipt.followUp !== "complete" ||
    receipt.appliedRevisionId !== archived.candidate.revisionId ||
    receipt.binding.candidateId !== archived.candidate.candidateId ||
    receipt.binding.maintenanceId !== archived.candidate.maintenanceId ||
    receipt.prepare.operationKey !== archived.candidate.prepareOperationKey ||
    !settle?.terminal ||
    settle.phase !== "terminal" ||
    settle.operation?.kind !== "configurationMaintenance.settle" ||
    settle.operation.candidateId !== receipt.binding.candidateId ||
    settle.operation.maintenanceId !== receipt.binding.maintenanceId ||
    settle.operation.prepareOperationKey !== receipt.prepare.operationKey ||
    settle.operation.prepareFingerprint !== receipt.prepare.operationFingerprint ||
    settle.operation.planDigest !== receipt.planDigest ||
    settle.operation.decisionId !== receipt.decision.decisionId ||
    settle.receiptDelivery?.state !== "confirmed" ||
    settle.receiptDelivery.terminalReceipt?.state !== "succeeded" ||
    canonicalJson(settle.receiptDelivery.terminalReceipt.result) !== canonicalJson(receipt) ||
    canonicalJson(settle.result) !== canonicalJson(receipt)
  )
    throw Error("Original completed coordinator receipt required");
  for (const source of Object.values(archived.steps)) {
    const step = receipt.steps[source.ordinal],
      actual = operations?.[source.operationKey];
    if (
      !step ||
      !actual?.terminal ||
      actual.phase !== "terminal" ||
      actual.receiptDelivery?.state !== "confirmed" ||
      actual.receiptDelivery.terminalReceipt?.state !== "succeeded" ||
      canonicalJson(actual.operation) !== canonicalJson(step.operation)
    )
      throw Error("Original completed coordinator step required");
  }
  return archived;
}
function projectedStep(
  result: Record<string, unknown>,
  operationKey: string,
  operation: OpsOperation,
) {
  const candidate = result._configurationCandidate as { candidateId?: unknown } | undefined,
    remote = result._configurationMaintenance as
      | { receipt?: { binding?: { candidateId?: unknown } } }
      | undefined;
  if (
    typeof candidate?.candidateId === "string" &&
    candidate.candidateId === remote?.receipt?.binding?.candidateId
  )
    return observedStep(result, operationKey, operation);
  const archived = completedCoordinatorMaintenance(result);
  return observedStep(
    {
      ...result,
      _configurationCandidate: archived.candidate,
      _configurationMaintenance: { receipt: archived.receipt },
      _configurationMaintenanceSteps: archived.steps,
    },
    operationKey,
    operation,
  );
}
/** Parser consistency only. This never constructs a source/authority handle. */
export function assertConfigurationMaintenanceProjectedStep(
  result: Record<string, unknown>,
  operationKey: string,
  operation: OpsOperation | undefined,
  rawAttempt: unknown,
): void {
  if (!operation) throw Error("Original frozen maintenance body required");
  const { source, receipt } = projectedStep(result, operationKey, operation),
    attempt = apiJobChildAttemptSchema.parse(rawAttempt);
  if (
    attempt.apiJobId !== receipt.apiJobId ||
    attempt.childOperationKey !== operationKey ||
    attempt.childOperationFingerprint !== opsOperationFingerprint(operation) ||
    attempt.requestedDeadlineAt !== source.requestedDeadlineAt ||
    attempt.parentOperationKey !== source.parent.operationKey ||
    attempt.parentFingerprint !== source.parent.fingerprint ||
    attempt.parentDeadlineAt !== source.parent.deadlineAt
  )
    throw Error("Original API purpose-bound maintenance step required");
}
/** Correlation address only, after the exact frozen projection has matched. */
export function configurationMaintenanceProjectedStepOrigin(
  result: Record<string, unknown>,
  operationKey: string,
  operation: OpsOperation,
  attempt: unknown,
): string {
  assertConfigurationMaintenanceProjectedStep(result, operationKey, operation, attempt);
  return projectedStep(result, operationKey, operation).receipt.prepare.operationKey;
}
