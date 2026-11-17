/** What a job keeps about its configuration maintenance once it settled. Parsing
 * it grants nothing; the agent's record is the authority. */
import { canonicalJson, maintenanceRecordSchema } from "@openmapx/core/ops";
import { z } from "zod";

const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);

/** The settle request that settled the maintenance. */
export const maintenanceSettleCheckpointSchema = z.strictObject({
  operationKey: key,
  outcome: z.enum(["complete", "abandon"]),
});

/** A coordinator update's maintenance, kept once it settled, so the rest of a
 * service batch can continue after it without the candidate. */
export const completedCoordinatorMaintenanceSchema = z.strictObject({
  version: z.literal(2),
  originalOrdinal: z.number().int().min(0).max(255),
  candidate: z.strictObject({
    candidateId: z.uuid(),
    maintenanceId: z.uuid(),
    prepareOperationKey: key,
    revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
    operationKey: key,
    phase: z.literal("settled"),
  }),
  record: maintenanceRecordSchema,
  settlementOperationKey: key,
});

/** The kept maintenance, checked against the settle operation's terminal copy. */
export function completedCoordinatorMaintenance(
  result: Record<string, unknown>,
  protocol: unknown,
) {
  const archived = completedCoordinatorMaintenanceSchema.parse(
      result._completedCoordinatorMaintenance,
    ),
    { record } = archived,
    settle = (
      (protocol as { operations?: { operations?: Record<string, unknown> } } | undefined)
        ?.operations?.operations as
        | Record<
            string,
            {
              terminal?: boolean;
              phase?: string;
              operation?: { kind?: string; maintenanceId?: string; outcome?: string };
              receiptDelivery?: { terminalReceipt?: { state?: string; result?: unknown } };
            }
          >
        | undefined
    )?.[archived.settlementOperationKey];
  if (
    record.state !== "settled" ||
    record.fence?.state !== "settled" ||
    record.generation !== "committed" ||
    record.followUp !== "complete" ||
    record.appliedRevisionId !== archived.candidate.revisionId ||
    record.binding.candidateId !== archived.candidate.candidateId ||
    record.maintenanceId !== archived.candidate.maintenanceId ||
    record.prepare.operationKey !== archived.candidate.prepareOperationKey ||
    !settle?.terminal ||
    settle.phase !== "terminal" ||
    settle.operation?.kind !== "configurationMaintenance.settle" ||
    settle.operation.maintenanceId !== record.maintenanceId ||
    settle.receiptDelivery?.terminalReceipt?.state !== "succeeded" ||
    canonicalJson(settle.receiptDelivery.terminalReceipt.result) !== canonicalJson(record)
  )
    throw Error("Original completed coordinator maintenance required");
  return archived;
}
