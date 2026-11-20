import z from "zod/v4";
import { executionRefSchema } from "../../../ops/execution-ref";
import {
  dataControlDelegationSchema,
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
export const dataConfigurationFenceInspectQuerySchema = z.strictObject({
  candidateId: z.uuid(),
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
/** The fence child the agent issued under the maintenance's lease travels with each request. */
export const dataConfigurationFencePrepareRequestSchema =
  dataConfigurationFencePrepareSchema.extend({
    delegation: dataControlDelegationSchema,
  });
/** Without a delegation the request is the operator's resolution, sent with the host CLI's token. */
export const dataConfigurationFenceSettleRequestSchema = dataConfigurationFenceSettleSchema.extend({
  delegation: dataControlDelegationSchema.optional(),
});
export type DataConfigurationFencePrepare = z.infer<typeof dataConfigurationFencePrepareSchema>;
export type DataConfigurationFenceReceipt = z.infer<typeof dataConfigurationFenceReceiptSchema>;
export type DataConfigurationFenceSettle = z.infer<typeof dataConfigurationFenceSettleSchema>;
export type DataConfigurationFencePrepareRequest = z.infer<
  typeof dataConfigurationFencePrepareRequestSchema
>;
export type DataConfigurationFenceSettleRequest = z.infer<
  typeof dataConfigurationFenceSettleRequestSchema
>;
