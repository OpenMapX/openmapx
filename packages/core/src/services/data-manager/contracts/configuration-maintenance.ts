import z from "zod/v4";
import { executionRefSchema } from "../../../ops/execution-ref";
import {
  dataCoordinatorModeSchema,
  dataEpochSchema,
  dataFingerprintSchema,
  dataRevisionSchema,
} from "./executions";

const binding = {
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  ownerPrepare: executionRefSchema,
  planDigest: dataFingerprintSchema,
  revisionId: dataRevisionSchema,
  hardlinkPlanDigest: dataFingerprintSchema.nullable(),
};
export const dataConfigurationFencePrepareSchema = z.strictObject({
  ...binding,
  serviceIds: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .min(1)
    .max(256)
    .refine((values) => values.every((value, i) => i === 0 || (values[i - 1] ?? value) < value)),
  coordinatorMode: dataCoordinatorModeSchema,
});
/** The data-manager's answer that an expired preparation was never admitted. It
 * can no longer be admitted, so the answer is final. */
export const configurationPrepareNonAdmissionSchema = z.strictObject({
  version: z.literal(2),
  kind: z.literal("configuration-prepare-not-admitted"),
  leaseId: z.uuid(),
  delegationId: z.uuid(),
  child: executionRefSchema,
  input: dataConfigurationFencePrepareSchema,
  observedAt: dataEpochSchema,
});
export type ConfigurationPrepareNonAdmission = z.infer<
  typeof configurationPrepareNonAdmissionSchema
>;
export const dataConfigurationFenceInspectQuerySchema = z.strictObject({
  candidateId: z.uuid(),
  ownerLeaseId: z.uuid(),
});
export const dataConfigurationFenceReceiptSchema = z.strictObject({
  ...binding,
  fenceId: z.uuid(),
  sequence: dataEpochSchema,
  state: z.enum(["prepared", "settled"]),
});
export const dataConfigurationFenceOutcomeSchema = z.enum(["applied", "unused", "contained"]);
export const dataConfigurationFenceSettleSchema = z.strictObject({
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  planDigest: dataFingerprintSchema,
  outcome: dataConfigurationFenceOutcomeSchema,
});
export type DataConfigurationFencePrepare = z.infer<typeof dataConfigurationFencePrepareSchema>;
export type DataConfigurationFenceReceipt = z.infer<typeof dataConfigurationFenceReceiptSchema>;
export type DataConfigurationFenceSettle = z.infer<typeof dataConfigurationFenceSettleSchema>;
