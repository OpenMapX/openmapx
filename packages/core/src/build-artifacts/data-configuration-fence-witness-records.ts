/** Original preparation witness data; schema parsing grants no authority. */
import { z } from "zod";
import { executionRefSchema } from "../ops/execution-ref";
import { dataConfigurationFenceReceiptSchema } from "../services/data-manager/contracts/configuration-maintenance";
import { controlOriginSchema } from "./control-records";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const dataConfigurationFencePreparedWitnessDomain =
  "openmapx-data-configuration-prepared-v2";
export const dataConfigurationFencePreparedWitnessSchema = z.strictObject({
  version: z.literal(2),
  installationId: z.uuid(),
  origin: controlOriginSchema,
  ownerPrepare: executionRefSchema,
  prepareExecution: executionRefSchema,
  prepareAdmissionDigest: digest,
  rootCertificateDigest: digest,
  preparedReceipt: dataConfigurationFenceReceiptSchema.refine(
    (value) => value.state === "prepared" && value.sequence === 0,
  ),
  preparedReceiptDigest: digest,
  preparedCanonicalDigest: digest,
  preparedTerminalAt: z.number().int().positive().safe(),
  guardDigest: digest,
  effectReceiptDigest: digest,
  effectSettlementDigest: digest,
});
export type DataConfigurationFencePreparedWitness = z.infer<
  typeof dataConfigurationFencePreparedWitnessSchema
>;
