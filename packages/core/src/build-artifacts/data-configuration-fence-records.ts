/** Exact existing DM mirror/SQL data schema; decoding creates no guard authority. */
import { z } from "zod";
import {
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceReceiptSchema,
  dataConfigurationFenceSettleSchema,
  legacyDataConfigurationFenceSettleSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { configurationSettlementSqlControlSchema } from "./configuration-fence-settlement-records";
import { controlOriginSchema } from "./control-records";

export const metadataSchema = z.strictObject({
  version: z.literal(1),
  guardState: z.enum(["preparing", "prepared", "settling", "settled", "recovery_required"]),
  receipt: dataConfigurationFenceReceiptSchema,
  input: dataConfigurationFencePrepareSchema,
  // Existing signed mirror/SQL bytes remain readable; the mutation boundary above
  // accepts only the new reference. Legacy presence never authorizes a new effect.
  settlement: z
    .union([legacyDataConfigurationFenceSettleSchema, dataConfigurationFenceSettleSchema])
    .optional(),
  settlementReservation: z
    .strictObject({
      version: z.literal(2),
      settlementId: z.string().regex(/^[a-f0-9]{64}$/),
      projectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
      reservationDigest: z.string().regex(/^[a-f0-9]{64}$/),
      capacityReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  settlementControl: z.lazy(() => configurationSettlementSqlControlSchema).optional(),
});
export const mirrorSchema = z.strictObject({
  preparedAt: z.number().int().positive().safe(),
  ownerCertificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  prepareAssertion: z.string().max(4096),
  version: z.literal(1),
  installationId: z.uuid(),
  origin: controlOriginSchema,
  metadata: metadataSchema,
});
