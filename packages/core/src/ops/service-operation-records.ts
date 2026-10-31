/** Fixed service input/result data. Decoding confers no execution authority. */
import { serviceImageReferenceSchema } from "@openmapx/extension-contracts/service";
import { z } from "zod";

const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const servicePullOperationSchema = z.strictObject({
  kind: z.literal("service.pull"),
  serviceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  expectedConfigurationRevisionId: revision,
  candidateId: z.uuid().optional(),
});
export const servicePullResultSchema = z.strictObject({
  changed: z.literal(true),
  revisionId: revision,
  imageReference: serviceImageReferenceSchema,
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  releaseSelectionDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type ServicePullResult = z.infer<typeof servicePullResultSchema>;
/** Retained read-only data, deliberately absent from opsOperationSchema and
 * fresh result validation. Neither shape can be dispatched or copied as proof. */
export const historicalServicePullOperationSchema = z.strictObject({
  kind: z.literal("service.pull"),
  serviceId: servicePullOperationSchema.shape.serviceId,
});
export const historicalServicePullResultSchema = z.strictObject({ changed: z.boolean() });
export type HistoricalServicePullOperation = z.infer<typeof historicalServicePullOperationSchema>;
export type HistoricalServicePullResult = z.infer<typeof historicalServicePullResultSchema>;
