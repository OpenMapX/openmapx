import z from "zod/v4";
import {
  type AdminOperation,
  adminCommonResponses,
  adminCountSchema,
  adminJson,
  adminJsonValueSchema,
  httpErrorSchema,
} from "../admin";
import { adminServiceJsonObjectSchema } from "./common";

export const adminSettingSchema = z.strictObject({
  group: z.string(),
  subgroup: z.string().optional(),
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: z.enum(["string", "number", "boolean", "object", "select"]),
  options: z.array(z.string()).optional(),
  secret: z.boolean(),
  /** A configured secret is always the redaction marker `***`, never its value. */
  value: adminJsonValueSchema,
  source: z.enum(["default", "database", "env"]),
  envVar: z.string().optional(),
  envOverride: z.boolean(),
  showWhen: z.strictObject({ key: z.string(), equals: adminJsonValueSchema }).optional(),
});
export const adminSettingsGroupSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  settings: z.array(adminSettingSchema),
});
export const adminSettingsSchema = z.strictObject({ groups: z.array(adminSettingsGroupSchema) });
export const adminSettingsUpdatedSchema = z.strictObject({
  ok: z.literal(true),
  groups: z.array(adminSettingsGroupSchema),
  /** Present when an authentication setting changed and sessions pick it up later. */
  authPolicyApplication: z.literal("pending").optional(),
});
export const adminTestEmailSentSchema = z.strictObject({
  ok: z.literal(true),
  message: z.string(),
});
const decimal = z.string().regex(/^\d{1,16}$/);
const filterText = z.string().max(256);
export const adminLogsQuerySchema = z.object({
  level: filterText.optional(),
  source: filterText.optional(),
  search: filterText.optional(),
  /** Epoch milliseconds; older entries are left out. */
  since: decimal.optional(),
  /** At most 500 entries are returned whatever the request asks for. */
  limit: decimal.optional(),
  offset: decimal.optional(),
});
export const adminLogEntrySchema = z.strictObject({
  id: z.number().int(),
  level: z.string(),
  source: z.string(),
  msg: z.string(),
  time: z.number(),
  metadata: z.record(z.string(), adminJsonValueSchema).optional(),
});
export const adminLogsSchema = z.strictObject({
  entries: z.array(adminLogEntrySchema),
  total: adminCountSchema,
  sources: z.array(z.string()),
});

export const settingsAdminOperations = {
  getAdminSettings: {
    method: "GET",
    path: "/api/admin/settings",
    auth: "admin",
    responses: { 200: adminJson(adminSettingsSchema), ...adminCommonResponses },
  },
  updateAdminSettings: {
    method: "PATCH",
    path: "/api/admin/settings",
    auth: "admin",
    request: { body: adminServiceJsonObjectSchema },
    responses: { 200: adminJson(adminSettingsUpdatedSchema), ...adminCommonResponses },
  },
  sendAdminTestEmail: {
    method: "POST",
    path: "/api/admin/settings/test-email",
    auth: "admin",
    responses: {
      200: adminJson(adminTestEmailSentSchema),
      ...adminCommonResponses,
      500: adminJson(
        z.union([httpErrorSchema, z.strictObject({ error: z.string(), details: z.string() })]),
      ),
    },
  },
  listAdminLogs: {
    method: "GET",
    path: "/api/admin/logs",
    auth: "admin",
    request: { query: adminLogsQuerySchema },
    responses: { 200: adminJson(adminLogsSchema), ...adminCommonResponses },
  },
} as const satisfies Record<string, AdminOperation>;

export type AdminSetting = z.infer<typeof adminSettingSchema>;
export type AdminSettingsGroup = z.infer<typeof adminSettingsGroupSchema>;
export type AdminLogEntry = z.infer<typeof adminLogEntrySchema>;
