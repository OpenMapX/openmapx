import z from "zod/v4";
import { adminJsonValueSchema } from "../admin";
import { adminJsonWire } from "../manifest-json";

// Registry lookup and dynamic manifest/domain validation belong to producers.
export const adminServiceParamsSchema = z.strictObject({ id: z.string().min(1) });
export const adminServiceCredentialParamsSchema = adminServiceParamsSchema.extend({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
});
export const adminServiceJsonObjectSchema = adminJsonWire(
  z.record(z.string(), adminJsonValueSchema),
);
export const adminServiceEmptyMutationSchema = z.strictObject({}).optional();
/** Shared acknowledgement of an application job, never its terminal outcome. */
export const adminServiceAcceptedSchema = z.strictObject({
  ok: z.literal(true),
  jobId: z.string().min(1),
});
export const adminServiceOkSchema = z.strictObject({ ok: z.literal(true) });
export const adminServiceFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.string(),
});
export const adminServiceValidationErrorSchema = z.strictObject({ errors: z.array(z.string()) });
export const adminServiceIdempotencyHeadersSchema = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
});
/** Reject malformed members rather than silently broadening a destructive selection. */
export const adminServiceIdListSchema = z.array(z.string().trim().min(1));

export type AdminServiceAccepted = z.infer<typeof adminServiceAcceptedSchema>;
export type AdminServiceValidationError = z.infer<typeof adminServiceValidationErrorSchema>;
export type AdminServiceJsonObject = z.infer<typeof adminServiceJsonObjectSchema>;
