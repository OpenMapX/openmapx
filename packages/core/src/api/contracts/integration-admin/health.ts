import z from "zod/v4";
import { adminCountSchema, adminTimestampSchema } from "../admin";

export const adminIntegrationHealthStatusSchema = z.enum(["up", "down", "unconfigured"]);
export const adminIntegrationHealthSummarySchema = z.strictObject({
  status: adminIntegrationHealthStatusSchema,
  responseTime: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
/** Actual service projection, including display URL and multi-check identities. */
export const adminIntegrationHealthResultSchema = adminIntegrationHealthSummarySchema.extend({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  url: z.string(),
});
export const adminIntegrationNoHealthCheckSchema = z.strictObject({
  id: z.string(),
  status: z.literal("unconfigured"),
  error: z.string(),
});
export const adminIntegrationHealthResponseSchema = z.union([
  adminIntegrationNoHealthCheckSchema,
  z.array(z.union([adminIntegrationHealthResultSchema, adminIntegrationNoHealthCheckSchema])),
]);
export const adminIntegrationHealthSweepSchema = z.strictObject({
  timestamp: adminTimestampSchema,
  count: adminCountSchema,
  results: z.array(adminIntegrationHealthResultSchema),
});
export const adminIntegrationHealthHistoryQuerySchema = z.strictObject({
  hours: z
    .preprocess(
      (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value),
      z.number().int().safe().min(1).max(168),
    )
    .default(24),
});
export const adminIntegrationHealthHistoryBucketSchema = z.strictObject({
  hour: adminTimestampSchema,
  total: adminCountSchema,
  healthy: adminCountSchema,
  uptimePercent: z.number().min(0).max(100),
  avgResponseTime: z.number().nonnegative().nullable(),
});
export const adminIntegrationHealthHistorySchema = z.strictObject({
  integrationId: z.string(),
  hours: z.number().int().min(1).max(168),
  timeline: z.array(adminIntegrationHealthHistoryBucketSchema),
});
export type AdminIntegrationHealthStatus = z.infer<typeof adminIntegrationHealthStatusSchema>;
export type AdminIntegrationHealthSummary = z.infer<typeof adminIntegrationHealthSummarySchema>;
export type AdminIntegrationHealthResult = z.infer<typeof adminIntegrationHealthResultSchema>;
export type AdminIntegrationHealthResponse = z.infer<typeof adminIntegrationHealthResponseSchema>;
export type AdminIntegrationHealthSweep = z.infer<typeof adminIntegrationHealthSweepSchema>;
export type AdminIntegrationHealthHistoryQuery = z.infer<
  typeof adminIntegrationHealthHistoryQuerySchema
>;
export type AdminIntegrationHealthHistoryBucket = z.infer<
  typeof adminIntegrationHealthHistoryBucketSchema
>;
export type AdminIntegrationHealthHistory = z.infer<typeof adminIntegrationHealthHistorySchema>;
