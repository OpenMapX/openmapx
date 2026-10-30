/** Shared non-secret original-source copies. Decoding grants no authority. */
import { z } from "zod";
import { configurationMaintenanceReceiptSchema } from "../ops/configuration-maintenance";
import { type OpsJobStatus, parseOpsJobStatus } from "../ops/contract";
import { executionRefSchema } from "../ops/execution-ref";
import { configurationMaintenanceDecisionCommitmentSchema } from "./configuration-maintenance-owner-records";
import { fixedConfigurationMaintenancePlanSchema } from "./fixed-configuration-maintenance";

export const configurationMaintenanceForwardDomain =
  "openmapx-configuration-maintenance-forward-v1";
const signed = z.strictObject({
  payload: z.unknown(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const configurationMaintenanceForwardGraphSchema = z.strictObject({
  version: z.literal(1),
  binding: z.lazy(() => configurationMaintenanceReceiptSchema.shape.binding),
  prepare: executionRefSchema,
  apiJobId: z.uuid(),
  parentOperationKey: z.string(),
  parentFingerprint: digest,
  parentDeadlineAt: z.number().int().positive().safe(),
  planDigest: digest,
  coordinatorImage: z.lazy(() => fixedConfigurationMaintenancePlanSchema.shape.coordinatorImage),
  handoff: z.lazy(() => fixedConfigurationMaintenancePlanSchema.shape.handoff),
  serviceIds: z.lazy(() => configurationMaintenanceReceiptSchema.shape.serviceIds),
  steps: z.lazy(() => configurationMaintenanceReceiptSchema.shape.steps),
});
export const configurationMaintenanceForwardSchema = z.strictObject({
  version: z.literal(1),
  graph: configurationMaintenanceForwardGraphSchema,
  rootAdmission: signed,
  decision: z.lazy(() => configurationMaintenanceDecisionCommitmentSchema).nullable(),
  generation: z
    .strictObject({
      admission: signed,
      terminal: signed,
      effect: signed,
      status: z
        .unknown()
        .transform((value) => parseOpsJobStatus(value) as OpsJobStatus)
        .refine((value) => value.diagnostics === undefined),
    })
    .nullable(),
});
