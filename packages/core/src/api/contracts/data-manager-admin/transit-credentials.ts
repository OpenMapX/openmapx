import { canonicalFeedCredentialMap } from "@openmapx/transitous-core/feed-credentials";
import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import { integrationHostApplyEvidenceSchema } from "../integration-admin/application";

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const currentRevision = z
  .string()
  .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
  .nullable();
const operationKey = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
const key = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      canonicalFeedCredentialMap({ [value]: "" });
      return true;
    } catch {
      return false;
    }
  }, "Invalid feed credential key");
const value = z
  .string()
  .max(8192)
  .refine((value) => {
    try {
      canonicalFeedCredentialMap({ validation: value });
      return true;
    } catch {
      return false;
    }
  }, "Credential exceeds its UTF-8 limit");
export const feedCredentialChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({ key, action: z.literal("set"), value }),
  z.strictObject({ key, action: z.literal("delete") }),
]);
export const feedCredentialPreviewInputSchema = z.strictObject({
  catalogRevisionId: revision,
  proposalId: z.uuid().optional(),
  expectedCredentialsRevision: revision,
  expectedCurrentRevisionId: currentRevision,
  operationKey,
  changes: z
    .array(feedCredentialChangeSchema)
    .min(1)
    .max(100)
    .refine((values) => new Set(values.map((value) => value.key)).size === values.length),
});
export const feedCredentialApplyInputSchema = z.strictObject({
  previewId: z.uuid(),
  intentFingerprint: revision,
  operationKey,
  transitProofToken: z.uuid(),
});
export const feedCredentialPreviewSchema = z.strictObject({
  previewId: z.uuid(),
  intentFingerprint: revision,
  catalogRevisionId: revision,
  proposalId: z.uuid().optional(),
  credentialsRevision: revision,
  expectedCurrentRevisionId: currentRevision,
  expiresAt: z.iso.datetime(),
  changes: z.array(z.strictObject({ key, action: z.enum(["set", "delete"]) })).max(100),
  preservedCount: z.number().int().nonnegative().max(10000),
  mapBytes: z.number().int().min(2).max(65536),
});
export const transitCredentialsSchema = z.strictObject({
  catalogRevisionId: revision,
  proposalId: z.uuid().optional(),
  credentialsRevision: revision,
  configurationRevisionId: currentRevision,
  owner: z.enum(["vault", "file", "environment", "unset"]),
  editable: z.boolean(),
  reason: z.string().nullable(),
  appliedCredentialsRevision: revision.nullable(),
  pendingApplication: z.boolean(),
  entries: z
    .array(
      z.strictObject({
        key,
        required: z.boolean(),
        configured: z.boolean(),
        orphaned: z.boolean(),
      }),
    )
    .max(11000),
});
export const feedCredentialApplyResultSchema = z.strictObject({
  credentialsRevision: revision,
  configuration: integrationHostApplyEvidenceSchema,
});
const responses = {
  ...adminCommonResponses,
  404: adminJson(httpErrorSchema),
  409: adminJson(httpErrorSchema),
  503: adminJson(httpErrorSchema),
};
export const transitCredentialOperations = {
  getAdminTransitCredentials: {
    method: "GET",
    path: "/api/admin/transit/credentials",
    auth: "admin",
    request: { query: z.object({ proposalId: z.uuid().optional() }) },
    responses: { ...responses, 200: adminJson(transitCredentialsSchema) },
  },
  previewAdminTransitCredentials: {
    method: "POST",
    path: "/api/admin/transit/credentials/preview",
    auth: "admin",
    request: { body: feedCredentialPreviewInputSchema },
    responses: { ...responses, 200: adminJson(feedCredentialPreviewSchema) },
  },
  applyAdminTransitCredentials: {
    method: "PATCH",
    path: "/api/admin/transit/credentials",
    auth: "admin",
    request: { body: feedCredentialApplyInputSchema },
    responses: { ...responses, 200: adminJson(feedCredentialApplyResultSchema) },
  },
} as const satisfies Record<string, AdminOperation>;
export type TransitCredentials = z.infer<typeof transitCredentialsSchema>;
export type FeedCredentialPreviewInput = z.infer<typeof feedCredentialPreviewInputSchema>;
