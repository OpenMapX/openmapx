import z from "zod/v4";
import { adminCountSchema as count, adminTimestampSchema as timestamp } from "./common";
/**
 * Persistent observations from getState/getAll, not the half-open lease-acquiring
 * getSnapshot view. `state` is what the next request meets: an open circuit whose
 * cooldown has ended reads as `half-open`.
 */
export const providerHealthEntrySchema = z.strictObject({
  id: z.string(),
  schema: z.literal(2),
  state: z.enum(["healthy", "degraded", "open", "half-open"]),
  successCount: count,
  failureCount: count,
  countedFailureCount: count,
  consecutiveSuccesses: count,
  consecutiveFailures: count,
  reopenCount: count,
  lastSuccessAt: timestamp.nullable().optional(),
  lastFailureAt: timestamp.nullable().optional(),
  lastFailureOutcome: z
    .enum([
      "timeout",
      "connection",
      "upstream_5xx",
      "auth",
      "invalid_payload",
      "valid_empty",
      "policy",
      "input",
      "quota",
      "caller_cancelled",
    ])
    .nullable()
    .optional(),
  lastOperatorMessage: z.string().nullable().optional(),
  emaLatencyMs: z.number().finite().nonnegative(),
  window: z.array(
    z.strictObject({
      outcome: z.enum(["ok", "error"]),
      at: timestamp,
      latencyMs: z.number().finite().nonnegative(),
    }),
  ),
  retryAt: timestamp.nullable().optional(),
  windowFailureRate: z.number().finite().min(0).max(1).nullable(),
});
export const providerHealthResponseSchema = z.strictObject({
  providers: z.array(providerHealthEntrySchema),
});
export const providerResetResponseSchema = z.strictObject({
  ok: z.literal(true),
  providerId: z.string(),
});
export type ProviderHealthEntry = z.infer<typeof providerHealthEntrySchema>;
export type ProviderHealthResponse = z.infer<typeof providerHealthResponseSchema>;
