/** Portable metadata only. No paths, credentials or file bodies cross the ops envelope. */
import z from "zod/v4";

const count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const owner = z.string().min(1).max(128);
const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
export const transferPurposeSchema = z.enum([
  "prepared-artifact",
  "instance-migration",
  "integration-artifact",
]);
export const transferDirectionSchema = z.enum(["upload", "download"]);
export const transferStageSchema = z.strictObject({
  stageId: z.uuid(),
  purpose: transferPurposeSchema,
  direction: transferDirectionSchema,
  state: z.enum([
    "created",
    "uploading",
    "uploaded",
    "validating",
    "ready",
    "claimed",
    "consumed",
    "failed",
    "expired",
  ]),
  bytes: count,
  sha256: digest.nullable(),
  expiresAt: z.iso.datetime(),
  cleanup: z.enum(["pending", "complete", "failed"]),
});
export const stageClaimUseSchema = z.enum([
  "inspect-integration",
  "install-integration",
  "validate-build",
  "import-build",
  "read-migration",
]);
export const stageClaimIdentitySchema = z.strictObject({
  executionId: z.string().regex(/^job1_[A-Za-z0-9_-]{16,64}$/),
  operationKey: key,
  fingerprint: digest,
  executionDeadlineAt: z.iso.datetime(),
});
export const stageInspectionBindingSchema = z.strictObject({
  inspectionId: z.uuid(),
  stageId: z.uuid(),
  sha256: digest,
  bytes: count,
  policyRevision: digest,
  validationFingerprint: digest,
  expiresAt: z.iso.datetime(),
});
export const artifactStageClaimSchema = z.strictObject({
  claimId: z.uuid(),
  stageId: z.uuid(),
  ownerId: owner,
  purpose: transferPurposeSchema,
  use: stageClaimUseSchema,
  identity: stageClaimIdentitySchema,
  sha256: digest,
  bytes: count,
});
export const stageClaimSettlementSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("validated"), inspection: stageInspectionBindingSchema }),
  z.strictObject({ outcome: z.literal("released"), evidence: z.enum(["no_effect", "restored"]) }),
  z.strictObject({ outcome: z.literal("consumed"), receiptId: z.string().min(1).max(256) }),
  z.strictObject({ outcome: z.literal("failed"), receiptId: z.string().min(1).max(256) }),
  z.strictObject({ outcome: z.literal("unknown"), receiptId: z.string().min(1).max(256) }),
]);
export const createTransferStageSchema = z.strictObject({
  purpose: transferPurposeSchema,
  direction: transferDirectionSchema,
  ownerId: owner,
  declaredBytes: count.optional(),
  expectedSha256: digest.optional(),
  operationKey: key,
});
export const inspectTransferStageSchema = z.strictObject({
  stageId: z.uuid(),
  ownerId: owner,
  purpose: transferPurposeSchema,
});
export const claimTransferStageSchema = inspectTransferStageSchema.extend({
  use: stageClaimUseSchema,
  identity: stageClaimIdentitySchema,
  expectedSha256: digest,
  inspection: stageInspectionBindingSchema.optional(),
});
export const artifactImportPreviewSchema = z.strictObject({
  stageId: z.uuid(),
  sha256: digest,
  serviceId: z.string().min(1).max(64),
  region: z.string().max(4096).nullable(),
  bytes: count,
  requiredFreeBytes: count,
  requiredCredentials: z.array(z.string().min(1).max(4096)).max(10000),
  runtimeImageMismatches: z
    .array(
      z.strictObject({
        service: z.string().max(64),
        bundle: z.string().max(4096),
        local: z.string().max(4096),
      }),
    )
    .max(256),
  runningConsumers: z.array(z.string().max(64)).max(256),
  blockers: z.array(z.string().max(512)).max(32),
  fingerprint: digest,
  currentRevisionId: z
    .string()
    .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
    .nullable(),
  expiresAt: z.iso.datetime(),
});
export const artifactPublicationResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("committed"),
    artifactFingerprint: digest,
    serviceId: z.string().max(64),
    followUp: z.enum(["complete", "failed"]),
    cleanupFailed: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("not_committed"),
    reason: z.enum(["conflict", "busy", "invalid", "failed"]),
    cleanupFailed: z.boolean(),
  }),
]);
export const artifactImportOperationSchema = z.strictObject({
  kind: z.literal("artifactTransfer.import"),
  stageId: z.uuid(),
  ownerId: owner,
  expectedSha256: digest,
  previewFingerprint: digest,
  expectedCurrentRevisionId: z
    .string()
    .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
    .nullable(),
});
export const artifactExportOperationSchema = z.strictObject({
  kind: z.literal("artifactTransfer.export"),
  serviceId: z.enum(["tileserver", "osrm", "otp", "pelias", "motis"]),
  ownerId: owner,
  expectedArtifactFingerprint: digest,
});
export const artifactTransferOperationSchemas = [
  z.strictObject({ kind: z.literal("artifactTransfer.capabilities"), ownerId: owner }),
  artifactExportOperationSchema,
  z.strictObject({
    kind: z.literal("artifactTransfer.previewImport"),
    stageId: z.uuid(),
    ownerId: owner,
  }),
  artifactImportOperationSchema,
  inspectTransferStageSchema.extend({
    kind: z.literal("artifactTransfer.validate"),
    purpose: z.literal("prepared-artifact"),
  }),
  createTransferStageSchema.extend({ kind: z.literal("artifactTransfer.create") }),
  z.strictObject({
    kind: z.literal("artifactTransfer.list"),
    ownerId: owner,
    limit: z.number().int().min(1).max(100).default(50),
    offset: count.default(0),
  }),
  inspectTransferStageSchema.extend({ kind: z.literal("artifactTransfer.inspect") }),
  z.strictObject({ kind: z.literal("artifactTransfer.delete"), stageId: z.uuid(), ownerId: owner }),
  claimTransferStageSchema.extend({ kind: z.literal("artifactTransfer.claim") }),
  z.strictObject({
    kind: z.literal("artifactTransfer.inspectClaim"),
    stageId: z.uuid(),
    ownerId: owner,
    identity: stageClaimIdentitySchema,
  }),
  z.strictObject({
    kind: z.literal("artifactTransfer.settle"),
    claim: artifactStageClaimSchema,
    settlement: stageClaimSettlementSchema,
  }),
] as const;
export const artifactTransferResultSchemas = {
  "artifactTransfer.capabilities": z.strictObject({
    limits: z.strictObject({
      maxUploadBytes: count,
      maxExpandedBytes: count,
      maxStageBytes: count,
      stageMs: count,
      downloadRetentionMs: count,
    }),
    freeBytes: count.nullable(),
    freeInodes: count.nullable(),
    reservedBytes: count,
    targets: z
      .array(
        z.strictObject({
          serviceId: z.string().max(64),
          available: z.boolean(),
          reason: z.string().max(512).nullable(),
          artifactFingerprint: digest.nullable(),
        }),
      )
      .max(5),
  }),
  "artifactTransfer.export": z.strictObject({
    stageId: z.uuid(),
    sha256: digest,
    bytes: count,
    expiresAt: z.iso.datetime(),
  }),
  "artifactTransfer.previewImport": artifactImportPreviewSchema,
  "artifactTransfer.import": artifactPublicationResultSchema,
  "artifactTransfer.validate": transferStageSchema,
  "artifactTransfer.create": transferStageSchema,
  "artifactTransfer.list": z.strictObject({
    items: z.array(transferStageSchema).max(100),
    total: count,
    limit: count,
    offset: count,
  }),
  "artifactTransfer.inspect": transferStageSchema,
  "artifactTransfer.delete": z.strictObject({ deleted: z.literal(true) }),
  "artifactTransfer.claim": artifactStageClaimSchema,
  "artifactTransfer.inspectClaim": z
    .strictObject({
      claim: artifactStageClaimSchema,
      settlement: stageClaimSettlementSchema.nullable(),
      /** Original signed publication and released-root observation, never a transfer-state inference. */
      publication: artifactPublicationResultSchema.optional(),
      validation: transferStageSchema.optional(),
    })
    .nullable(),
  "artifactTransfer.settle": transferStageSchema,
} as const;
export type TransferPurpose = z.infer<typeof transferPurposeSchema>;
export type TransferDirection = z.infer<typeof transferDirectionSchema>;
export type TransferStage = z.infer<typeof transferStageSchema>;
export type StageClaimUse = z.infer<typeof stageClaimUseSchema>;
export type StageClaimIdentity = z.infer<typeof stageClaimIdentitySchema>;
export type StageInspectionBinding = z.infer<typeof stageInspectionBindingSchema>;
export type ArtifactStageClaim = z.infer<typeof artifactStageClaimSchema>;
export type StageClaimSettlement = z.infer<typeof stageClaimSettlementSchema>;
export type CreateTransferStage = z.infer<typeof createTransferStageSchema>;
export type ClaimTransferStage = z.infer<typeof claimTransferStageSchema>;
export function stagePurposeAllowsUse(purpose: TransferPurpose, use: StageClaimUse): boolean {
  return purpose === "integration-artifact"
    ? ["inspect-integration", "install-integration"].includes(use)
    : purpose === "prepared-artifact"
      ? ["validate-build", "import-build"].includes(use)
      : use === "read-migration";
}

export type ArtifactImportPreview = z.infer<typeof artifactImportPreviewSchema>;
export type ArtifactPublicationResult = z.infer<typeof artifactPublicationResultSchema>;
