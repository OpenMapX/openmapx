import z from "zod/v4";
import { REQUEST_STATES } from "../../../privacy/request-states";
import { adminTimestampSchema as date } from "../admin";
export const privacyCaseViewSchema = z.strictObject({
  id: z.uuid(),
  originalDueAt: date.optional(),
  kind: z.enum(["access", "portability", "access_and_portability"]),
  channel: z.string(),
  state: z.enum(REQUEST_STATES),
  userId: z.string().nullable(),
  locale: z.string(),
  timeZone: z.string(),
  receivedAt: date,
  registeredAt: date,
  dueAt: date,
  extension: z
    .strictObject({ extendedUntil: date, extensionNotifiedAt: date, reasonCode: z.string() })
    .nullable(),
  identityMethod: z.enum(["account_session", "manual"]).nullable(),
  identityVerifiedAt: date.nullable(),
  locatorType: z.string(),
  accountState: z.string(),
  refusalCode: z.string().nullable(),
  completedAt: date.nullable(),
  closedAt: date.nullable(),
  version: z.number().int().positive(),
  createdAt: date,
  updatedAt: date,
});
export const privacyOperatorTaskSchema = z.strictObject({
  id: z.uuid(),
  registrationId: z.string(),
  source: z.string(),
  status: z.enum(["open", "resolved"]),
  publicCode: z.string().nullable(),
  resolutionCode: z.string().nullable(),
  resolvedAt: date.nullable(),
});
export const privacyCaseCapabilitiesSchema = z.strictObject({
  verifyIdentity: z.boolean(),
  resolveTasks: z.boolean(),
  extendDeadline: z.boolean(),
  caseDecision: z.boolean(),
  export: z.boolean(),
  reasons: z.record(z.string(), z.string().max(128)),
});
export const privacyAdminDetailSchema = z.strictObject({
  request: privacyCaseViewSchema,
  tasks: z.array(privacyOperatorTaskSchema),
  events: z.array(
    z.strictObject({
      eventType: z.string(),
      actorKind: z.string(),
      createdAt: date,
      payload: z.record(z.string(), z.string().max(128)).optional(),
    }),
  ),
  capabilities: privacyCaseCapabilitiesSchema,
});
export const privacyErrorSchema = z.union([
  z.strictObject({ code: z.string().max(128) }),
  z.object({
    error: z.string(),
    statusCode: z.number().optional(),
    message: z.string().optional(),
    code: z.string().optional(),
  }),
]);
export const privacyExportHeaders = z.object({
  "content-disposition": z
    .string()
    .max(512)
    .regex(/^attachment; filename="[A-Za-z0-9][A-Za-z0-9._ -]*"$/),
  "cache-control": z.literal("private, no-store"),
  "x-content-type-options": z.literal("nosniff"),
  "referrer-policy": z.literal("no-referrer"),
});
export type PrivacyCaseView = z.infer<typeof privacyCaseViewSchema>;
export type PrivacyAdminDetail = z.infer<typeof privacyAdminDetailSchema>;
export type PrivacyCaseCapabilities = z.infer<typeof privacyCaseCapabilitiesSchema>;
export type PrivacyOperatorTask = z.infer<typeof privacyOperatorTaskSchema>;
