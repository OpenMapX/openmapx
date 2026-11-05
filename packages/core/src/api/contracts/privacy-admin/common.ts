import z from "zod/v4";
import {
  attachmentMediaTypeSchema,
  attachmentMetadataSchema,
  attachmentPurposeSchema,
} from "../../../privacy/admin-contracts";
import { adminTimestampSchema as date } from "../admin";
export const privacyCaseViewSchema = z.strictObject({
  id: z.uuid(),
  originalDueAt: date.optional(),
  kind: z.enum(["access", "portability", "access_and_portability"]),
  channel: z.string(),
  state: z.string(),
  userId: z.string().nullable(),
  locale: z.string(),
  timeZone: z.string(),
  receivedAt: date,
  registeredAt: date,
  dueAt: date,
  extension: z
    .strictObject({ extendedUntil: date, extensionNotifiedAt: date, reasonCode: z.string() })
    .nullable(),
  identityState: z.string(),
  locatorType: z.string(),
  accountState: z.string(),
  refusalCode: z.string().nullable(),
  deliveryState: z.string(),
  version: z.number().int().positive(),
  createdAt: date,
  updatedAt: date,
});
export const privacyOperatorTaskSchema = z.strictObject({
  id: z.uuid(),
  taskKey: z.string(),
  actions: z
    .array(z.enum(["complete", "not_applicable", "operator_review", "retryable", "canceled"]))
    .optional(),
  registrationId: z.string(),
  source: z.string(),
  required: z.union([z.literal(0), z.literal(1)]),
  status: z.string(),
  attempts: z.number().int().nonnegative(),
  assignedTo: z.string().nullable(),
  cutoffAt: date.nullable(),
  collectedAt: date.nullable(),
  recordCount: z.number().int().nullable(),
  exceptionCode: z.string().nullable(),
  redactionCode: z.string().nullable(),
});
export const privacyIdentityViewSchema = z.strictObject({
  party: z.enum(["subject", "representative"]),
  state: z.string(),
  method: z.string().nullable(),
  authorityState: z.string(),
  deliveryAuthorized: z.union([z.literal(0), z.literal(1)]),
  verifiedAt: date.nullable(),
});
export const privacyAttachmentViewSchema = z.strictObject({
  id: z.uuid(),
  purpose: attachmentPurposeSchema,
  filename: z.string(),
  mediaType: attachmentMediaTypeSchema,
  plaintextBytes: z.number().int().nonnegative(),
  expiresAt: date,
  rightsReviewState: z.enum(["pending", "approved", "redacted", "rejected"]),
  metadata: attachmentMetadataSchema.or(z.strictObject({})),
  createdAt: date.optional(),
});
export const privacyArtifactViewSchema = z.strictObject({
  id: z.uuid(),
  state: z.string(),
  filename: z.string().nullable(),
  mediaType: z.string().nullable().optional(),
  plaintextBytes: z.number().int().nonnegative().nullable(),
  expiresAt: date.nullable(),
  readyAt: date.nullable().optional(),
});
export const privacyCaseCapabilitiesSchema = z.strictObject({
  identityReview: z.boolean(),
  taskDecision: z.boolean(),
  taskAssignment: z.boolean(),
  extendDeadline: z.boolean(),
  caseDecision: z.boolean(),
  attachmentWrite: z.boolean(),
  backupReview: z.boolean(),
  generate: z.boolean(),
  assistedDelivery: z.boolean(),
  representativeDelivery: z.boolean(),
  reasons: z.record(z.string(), z.string().max(128)),
});
export const privacyAdminDetailSchema = z.strictObject({
  request: privacyCaseViewSchema,
  tasks: z.array(privacyOperatorTaskSchema),
  identities: z.array(privacyIdentityViewSchema),
  attachments: z.array(privacyAttachmentViewSchema),
  artifacts: z.array(privacyArtifactViewSchema),
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
export const privacyDownloadHeaders = z.object({
  "content-disposition": z
    .string()
    .max(512)
    .regex(/^attachment; filename="[A-Za-z0-9][A-Za-z0-9._ -]*"$/),
  "content-length": z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/)
    .optional(),
  "cache-control": z.literal("private, no-store"),
  "x-content-type-options": z.literal("nosniff"),
  "referrer-policy": z.literal("no-referrer"),
});
export const privacyBackupReviewViewSchema = z.strictObject({
  id: z.uuid(),
  requestId: z.uuid(),
  backupId: z.string(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: date,
  platformVersion: z.string(),
  decision: z.enum(["not_applicable", "no_material_difference", "extract", "unavailable"]),
  reasonCode: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: date,
});
export const privacyBackupOmissionViewSchema = z.strictObject({
  backupReviewId: z.string(),
  manifestDigest: z.string(),
  warningCodes: z.array(z.string()),
  warningsDigest: z.string(),
  accepted: z.boolean(),
  requestVersion: z.number().int().positive().optional(),
  reasonCode: z.string().optional(),
});
export type PrivacyCaseView = z.infer<typeof privacyCaseViewSchema>;
export type PrivacyAdminDetail = z.infer<typeof privacyAdminDetailSchema>;
export type PrivacyCaseCapabilities = z.infer<typeof privacyCaseCapabilitiesSchema>;
export type PrivacyOperatorTask = z.infer<typeof privacyOperatorTaskSchema>;
export type PrivacyAttachmentView = z.infer<typeof privacyAttachmentViewSchema>;
