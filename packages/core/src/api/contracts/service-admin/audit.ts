import z from "zod/v4";
import { adminActorSummarySchema } from "../activity-admin";
import {
  type AdminOperation,
  adminCommonResponses,
  adminCountSchema,
  adminJson,
  adminJsonValueSchema,
  adminTimestampSchema,
} from "../admin";
import { AUDIT_ACTION_NAMES, AUDIT_TARGET_TYPES } from "./audit-actions";

const decimal = z.string().regex(/^\d{1,16}$/);
const filterText = z.string().max(256);
const auditActionSchema = z.enum(AUDIT_ACTION_NAMES);
const auditTargetTypeSchema = z.enum(AUDIT_TARGET_TYPES);
const auditFilters = {
  action: auditActionSchema.optional(),
  targetType: auditTargetTypeSchema.optional(),
  targetId: filterText.optional(),
  actorId: filterText.optional(),
};
export const adminAuditQuerySchema = z.object({
  ...auditFilters,
  /** At most 200 entries are returned whatever the request asks for. */
  limit: decimal.optional(),
  offset: decimal.optional(),
});
export const adminAuditExportQuerySchema = z.object({
  ...auditFilters,
  format: z.enum(["csv", "json"]).optional(),
});
export const adminAuditEntrySchema = z.strictObject({
  id: z.string(),
  actorId: z.string().nullable(),
  targetId: z.string().nullable(),
  targetType: auditTargetTypeSchema.nullable(),
  action: auditActionSchema,
  details: adminJsonValueSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: adminTimestampSchema,
  actor: adminActorSummarySchema.nullable(),
});
export const adminAuditLogSchema = z.strictObject({
  entries: z.array(adminAuditEntrySchema),
  total: adminCountSchema,
});

export const auditAdminOperations = {
  listAdminAuditLog: {
    method: "GET",
    path: "/api/admin/audit",
    auth: "admin",
    request: { query: adminAuditQuerySchema },
    responses: { 200: adminJson(adminAuditLogSchema), ...adminCommonResponses },
  },
  /** The newest 10,000 matching entries; `x-export-truncated` marks a longer log. */
  exportAdminAuditLog: {
    method: "GET",
    path: "/api/admin/audit/export",
    auth: "admin",
    request: { query: adminAuditExportQuerySchema },
    responses: {
      200: {
        kind: "text-download",
        mediaTypes: ["text/csv", "application/json"],
        mediaTypeQuery: {
          name: "format",
          default: "json",
          values: { csv: "text/csv", json: "application/json" },
        },
        headers: z.object({
          "content-disposition": z.string().startsWith("attachment;"),
          "x-export-truncated": z.literal("true").optional(),
        }),
      },
      ...adminCommonResponses,
    },
  },
} as const satisfies Record<string, AdminOperation>;

export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;
