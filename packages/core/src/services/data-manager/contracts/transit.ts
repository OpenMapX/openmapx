import z from "zod/v4";
import { countSchema, timestampSchema } from "./common";
export const transitSourceLifecycleSchema = z.enum([
  "active",
  "add-pending",
  "update-pending",
  "removal-pending",
  "disabled",
  "failed",
  "stale",
]);
/** Catalog licences are source-owned JSON metadata, not the captured mobility licensing format. */
export const transitLicenseSchema = z.record(z.string(), z.json());
const sourceShape = {
  id: z.string(),
  region: z.string(),
  name: z.string(),
  format: z.enum(["gtfs", "netex"]),
  origin: z.enum(["catalog", "operator"]),
  originUrl: z.string().optional(),
  license: transitLicenseSchema,
  requested: z.boolean(),
};
export const transitCatalogSourceSchema = z
  .strictObject(sourceShape)
  .omit({ origin: true, requested: true });
export const transitSourceRowSchema = z.strictObject({
  ...sourceShape,
  active: z.boolean(),
  activeEpoch: z.string().optional(),
  artifact: z
    .strictObject({
      path: z.string(),
      sha256: z.string(),
      sizeBytes: countSchema,
      retrievedAt: timestampSchema,
    })
    .optional(),
  lastFetchedAt: timestampSchema.optional(),
  lastImportedAt: timestampSchema.optional(),
  validationStatus: z.string().optional(),
  validationMessage: z.string().optional(),
  lifecycle: transitSourceLifecycleSchema,
});
export const transitSourceListSchema = z.strictObject({
  sources: z.array(transitSourceRowSchema),
  total: countSchema,
  limit: countSchema,
  offset: countSchema,
});
export const transitCatalogSchema = z.strictObject({
  sources: z.array(transitCatalogSourceSchema),
});
export const transitPolicySchema = z.strictObject({
  profile: z.enum(["regional-assisted", "regional-sovereign", "planet"]),
  countries: z.array(z.string()),
  feedAllowList: z.array(z.string()),
  acquisition: z.enum(["mirror", "build"]),
  artifactOrigins: z.array(z.string()),
  originDownloadsRequired: z.boolean(),
  hostedRuntimeFallbackAllowed: z.boolean(),
  osmInput: z.string().optional(),
  gbfsSelection: z.enum(["explicit-countries", "explicit-feeds", "allow-listed-batches"]),
  maxFeedCount: countSchema,
  retentionGenerations: countSchema,
  resourceEnvelope: z.strictObject({
    minimumMemoryGb: countSchema,
    minimumCpu: countSchema,
    minimumDiskGb: countSchema,
    operatorCapacityRequired: z.boolean(),
  }),
  updateCadenceHours: countSchema,
  experimental: z.boolean(),
});
export const transitProfileSchema = z.strictObject({ policy: transitPolicySchema });
export const transitSourcesQuerySchema = z.strictObject({
  search: z.string().optional(),
  lifecycle: transitSourceLifecycleSchema.optional(),
  origin: z.enum(["catalog", "operator"]).optional(),
  limit: z.coerce.number().finite().optional(),
  offset: z.coerce.number().finite().optional(),
});
const mutationShape = {
  idempotencyKey: z.string().max(200).optional(),
  triggeredBy: z.string().max(200).optional(),
};
export const transitMutationRequestSchema = z.strictObject(mutationShape).optional();
export const addTransitSourceRequestSchema = z.strictObject({
  ...mutationShape,
  region: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
  license: z.strictObject({
    spdxIdentifier: z.string().optional(),
    url: z.string().optional(),
    attribution: z.string().min(1),
    publisher: z.string().optional(),
    publisherUrl: z.string().optional(),
  }),
});
export const transitSourceMutationResultSchema = z.strictObject({
  jobId: z.string(),
  sourceId: z.string(),
  status: z.literal("started"),
});
export const transitConflictSchema = z.strictObject({
  ok: z.literal(false),
  reason: z.enum(["in-flight", "duplicate-idempotency-key"]),
  existingJobId: z.string().nullable(),
});
export const transitSyncRequestSchema = z
  .strictObject({
    ...mutationShape,
    countries: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/))
      .max(250)
      .optional(),
  })
  .optional();
export const transitSyncAcceptedSchema = z.strictObject({
  ok: z.literal(true),
  jobId: z.string(),
  status: z.literal("started"),
});
export const transitScopeRejectedSchema = z.strictObject({
  ok: z.literal(false),
  reason: z.string(),
});
const capacityShape = {
  freeDiskBytes: countSchema,
  freeInodes: countSchema.optional(),
  slotMemoryGb: countSchema,
  slotCpu: countSchema,
  fileDescriptorLimit: countSchema,
  buildTimeoutHours: countSchema,
};
export const transitPreflightRequestSchema = z
  .strictObject({
    feedCount: countSchema.optional(),
    measuredCompressedBytes: countSchema.optional(),
    osmBytes: countSchema.optional(),
    osmAvailable: z.boolean().optional(),
    freeDiskBytes: countSchema.optional(),
    freeInodes: countSchema.optional(),
    slotMemoryGb: countSchema.optional(),
    slotCpu: countSchema.optional(),
    fileDescriptorLimit: countSchema.optional(),
    buildTimeoutHours: countSchema.optional(),
  })
  .optional();
export const transitPreflightSchema = z.strictObject({
  ok: z.boolean(),
  policy: transitPolicySchema,
  estimate: z.strictObject({
    feedCount: countSchema,
    measuredCompressedBytes: countSchema,
    compressedBytes: countSchema,
    expandedGtfsBytes: countSchema,
    importedMotisBytes: countSchema,
    osmBytes: countSchema,
    proxyCacheBytes: countSchema,
    requiredDiskBytes: countSchema,
    basis: z.enum(["measured-and-conservative", "conservative-defaults"]),
  }),
  capacity: z.strictObject(capacityShape),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
const safeGitRef = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (v) => !v.includes("..") && !v.includes("@{") && !v.endsWith("/") && !v.endsWith(".lock"),
  );
export const transitBumpRequestSchema = z
  .strictObject({
    branch: safeGitRef.optional(),
    force: z.boolean().optional(),
    lockedBy: z.string().optional(),
  })
  .optional();
export const transitBumpResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    unchanged: z.literal(true),
    ref: z.string(),
    previousRef: z.string().nullable(),
  }),
  z.strictObject({
    ok: z.literal(true),
    unchanged: z.literal(false),
    proposed: z.literal(true),
    ref: z.string(),
    previousRef: z.string().nullable(),
    submoduleSha: z.string(),
    lockedAt: timestampSchema,
    lockedBy: z.string(),
  }),
]);
export const transitApproveRequestSchema = z
  .strictObject({ approveRef: z.string().optional(), approvedBy: z.string().optional() })
  .optional();
export const transitApprovalMismatchSchema = z.strictObject({
  ok: z.literal(false),
  error: z.literal("typed-confirmation-mismatch"),
  expected: z.string(),
});
export const transitApprovalSchema = z.strictObject({
  ok: z.literal(true),
  activated: z.literal(true),
  ref: z.string(),
  lockedAt: timestampSchema,
});
export type TransitSourceLifecycle = z.infer<typeof transitSourceLifecycleSchema>;
export type TransitSourceRow = z.infer<typeof transitSourceRowSchema>;
export type TransitSourceListResult = z.infer<typeof transitSourceListSchema>;
export type TransitSourceMutationResult = z.infer<typeof transitSourceMutationResultSchema>;
export type MotisOperationsPolicy = z.infer<typeof transitPolicySchema>;
export type MotisPreflightResult = z.infer<typeof transitPreflightSchema>;

export type TransitSourceListQuery = z.infer<typeof transitSourcesQuerySchema>;
export type TransitCatalogSource = z.infer<typeof transitCatalogSourceSchema>;
