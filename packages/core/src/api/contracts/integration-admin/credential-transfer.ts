import { isWellFormedFeedCredentialText } from "@openmapx/transitous-core/feed-credentials";
import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";

/** Public checked reference for decrypt-only review, never apply authority. */
export const CREDENTIAL_TRANSFER_PREVIEW_INTENT =
  "ee5994a7b7b38c0a7039f3f8ac7f3d16d74f6b8ffa45210e7d94190d93748bd0";
const encoded = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .length(Math.ceil((bytes * 4) / 3));
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const key = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
export const credentialTransferFieldSchema = z.strictObject({
  scope: z.enum(["integration", "service"]),
  id,
  key,
});
export const credentialTransferEnvelopeSchema = z.strictObject({
  format: z.literal("openmapx-vault-transfer"),
  version: z.literal(1),
  kdf: z.strictObject({
    name: z.literal("scrypt"),
    N: z.literal(32768),
    r: z.literal(8),
    p: z.literal(1),
    salt: encoded(16),
  }),
  cipher: z.strictObject({ name: z.literal("aes-256-gcm"), iv: encoded(12), tag: encoded(16) }),
  ciphertext: z
    .string()
    .min(1)
    .max(1048576)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type CredentialTransferEnvelope = z.infer<typeof credentialTransferEnvelopeSchema>;
export const credentialImportChoicesSchema = z.strictObject({
  entries: z
    .array(credentialTransferFieldSchema.extend({ action: z.enum(["import", "skip"]) }))
    .max(1000),
  feedMap: z
    .strictObject({
      catalogRevisionId: z.string().min(1).max(256),
      expectedCredentialsRevision: z.string().min(1).max(256),
      setKeys: z.array(z.string().min(1).max(1024)).max(1000),
      deleteKeys: z.array(z.string().min(1).max(1024)).max(1000),
    })
    .optional(),
});
export type CredentialImportChoices = z.infer<typeof credentialImportChoicesSchema>;
const passphrase = z
  .string()
  .refine(
    (v) =>
      isWellFormedFeedCredentialText(v) &&
      new TextEncoder().encode(v).length >= 12 &&
      new TextEncoder().encode(v).length <= 1024,
  );
export const credentialExportInputSchema = z.strictObject({
  selection: z.array(credentialTransferFieldSchema).min(1).max(1000),
  passphrase,
  confirmed: z.literal(true),
});
export type CredentialExportInput = z.infer<typeof credentialExportInputSchema>;
export const credentialImportPreviewSchema = z.strictObject({
  previewId: z.uuid(),
  intentFingerprint: z.string().min(1).max(128),
  expectedCurrentRevisionId: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  entries: z
    .array(
      credentialTransferFieldSchema.extend({
        status: z.enum(["selected", "skipped", "denied"]),
        reason: z.string().optional(),
      }),
    )
    .max(1000),
  feedMap: z
    .strictObject({
      previewId: z.uuid(),
      intentFingerprint: z.string(),
      catalogRevisionId: z.string(),
      credentialsRevision: z.string(),
      expectedCurrentRevisionId: z.string().nullable(),
      expiresAt: z.iso.datetime(),
      changes: z
        .array(z.strictObject({ key: z.string(), action: z.enum(["set", "delete"]) }))
        .max(1000),
      preservedCount: z.number().int().nonnegative(),
      mapBytes: z.number().int().nonnegative(),
    })
    .optional(),
  applyable: z.boolean(),
});
export type CredentialImportPreview = z.infer<typeof credentialImportPreviewSchema>;
export const credentialTransferApplySchema = z.strictObject({
  previewId: z.uuid(),
  intentFingerprint: z.string().min(1).max(128),
  expectedCurrentRevisionId: z.string().nullable(),
  importProofToken: z.uuid(),
  transitProofToken: z.uuid().optional(),
});
const headers = z.object({
  "idempotency-key": z.string().min(1).max(128),
  "x-admin-reauth-proof": z.uuid().optional(),
});
export const migrationOperationResultSchema = z.strictObject({
  operationId: z.string(),
  outcome: z.enum(["applied", "partial", "failed", "unknown"]),
  steps: z.array(
    z.strictObject({
      scope: z.string(),
      id: z.string(),
      status: z.enum(["applied", "failed", "pending", "unknown"]),
    }),
  ),
});
const transferResponses = {
  ...adminCommonResponses,
  409: adminJson(httpErrorSchema),
  503: adminJson(httpErrorSchema),
};
export const credentialTransferOperations = {
  exportAdminCredentialTransfer: {
    method: "POST",
    path: "/api/admin/credential-transfer/export",
    auth: "admin",
    request: { body: credentialExportInputSchema },
    responses: { ...transferResponses, 200: adminJson(credentialTransferEnvelopeSchema) },
  },
  previewAdminCredentialTransfer: {
    method: "POST",
    path: "/api/admin/credential-transfer/preview",
    auth: "admin",
    request: {
      body: z.strictObject({
        envelope: credentialTransferEnvelopeSchema,
        passphrase,
        choices: credentialImportChoicesSchema.optional(),
      }),
      headers,
    },
    responses: { ...transferResponses, 200: adminJson(credentialImportPreviewSchema) },
  },
  chooseAdminCredentialTransferFields: {
    method: "POST",
    path: "/api/admin/credential-transfer/preview/:previewId/choices",
    auth: "admin",
    request: {
      params: z.strictObject({ previewId: z.uuid() }),
      body: z.strictObject({
        choices: credentialImportChoicesSchema,
        expectedIntentFingerprint: z.string().min(1).max(128),
      }),
      headers,
    },
    responses: { ...transferResponses, 200: adminJson(credentialImportPreviewSchema) },
  },
  applyAdminCredentialTransfer: {
    method: "POST",
    path: "/api/admin/credential-transfer/apply",
    auth: "admin",
    request: { body: credentialTransferApplySchema, headers },
    responses: { ...transferResponses, 200: adminJson(migrationOperationResultSchema) },
  },
} as const satisfies Record<string, AdminOperation>;
