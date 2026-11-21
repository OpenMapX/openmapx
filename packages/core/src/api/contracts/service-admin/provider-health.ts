import z from "zod/v4";
import { uncachedResponseHeadersSchema } from "../../../services/data-manager/contracts/headers";
import {
  type AdminOperation,
  adminCommonResponses,
  adminJson,
  adminCountSchema as count,
  httpErrorSchema,
  adminTimestampSchema as timestamp,
} from "../admin";
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

const providerParams = z.strictObject({ id: z.string().min(1) });

/** The API's own upstream provider health, kept in Redis by this process. */
export const providerHealthAdminOperations = {
  listAdminProviderHealth: {
    method: "GET",
    path: "/api/admin/providers",
    auth: "admin",
    responses: {
      ...adminCommonResponses,
      200: adminJson(providerHealthResponseSchema, uncachedResponseHeadersSchema),
    },
  },
  getAdminProviderHealth: {
    method: "GET",
    path: "/api/admin/providers/:id",
    auth: "admin",
    request: { params: providerParams },
    responses: {
      ...adminCommonResponses,
      200: adminJson(providerHealthEntrySchema, uncachedResponseHeadersSchema),
      404: adminJson(httpErrorSchema, uncachedResponseHeadersSchema),
    },
  },
  resetAdminProviderHealth: {
    method: "POST",
    path: "/api/admin/providers/:id/reset",
    auth: "admin",
    request: { params: providerParams },
    responses: {
      ...adminCommonResponses,
      200: adminJson(providerResetResponseSchema, uncachedResponseHeadersSchema),
      503: adminJson(httpErrorSchema, uncachedResponseHeadersSchema),
    },
  },
} as const satisfies Record<string, AdminOperation>;
