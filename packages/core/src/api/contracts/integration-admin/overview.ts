import z from "zod/v4";
import { adminActivityJobSchema } from "../activity-admin";
import { adminCountSchema, adminJsonValueSchema, adminTimestampSchema } from "../admin";

/** Raw audit DB row serialized by the overview producer; no actor enrichment. */
export const adminIntegrationAuditEntrySchema = z.strictObject({
  id: z.string(),
  actorId: z.string().nullable(),
  targetId: z.string().nullable(),
  targetType: z.string().nullable(),
  action: z.string(),
  details: adminJsonValueSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: adminTimestampSchema,
});
export const adminOverviewSchema = z.strictObject({
  systemHealth: z.strictObject({
    status: z.enum(["pass", "degraded", "down"]),
    unhealthyCount: adminCountSchema,
  }),
  users: z.strictObject({
    total: adminCountSchema,
    active24h: adminCountSchema,
    banned: adminCountSchema,
  }),
  integrations: z.strictObject({
    total: adminCountSchema,
    enabled: adminCountSchema,
    unhealthy: adminCountSchema,
    unconfigured: adminCountSchema,
  }),
  services: z
    .strictObject({
      running: adminCountSchema,
      stopped: adminCountSchema,
      unknown: adminCountSchema,
      unhealthy: adminCountSchema,
    })
    .nullable(),
  attention: z.array(
    z.strictObject({
      type: z.string(),
      severity: z.enum(["warning", "error", "info"]),
      message: z.string(),
      target: z.string().optional(),
    }),
  ),
  recentActivity: z.array(adminIntegrationAuditEntrySchema),
  activeJobs: z.array(adminActivityJobSchema),
});
export type AdminIntegrationAuditEntry = z.infer<typeof adminIntegrationAuditEntrySchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
