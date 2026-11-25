import z from "zod/v4";
import {
  offlineMapPackageManifestSchema,
  offlinePackageRequestSchema,
} from "../../../offline/offlinePackage";
import { countSchema } from "./common";

export { offlineMapPackageManifestSchema, offlinePackageRequestSchema };

const bbox = offlinePackageRequestSchema.shape.bbox;
export const offlineSourceDescriptorSchema = z.strictObject({
  datasetId: z.literal("openmapx"),
  datasetVersion: z.string(),
  sourceMaxZoom: countSchema,
  sourceBounds: bbox,
  tileSchema: z.literal("openmaptiles"),
  glyphsVersion: z.string(),
  packageAlgorithmVersion: z.string(),
  attribution: z.array(z.string()),
});
export const canonicalOfflinePackageRequestSchema = z.strictObject({
  request: offlinePackageRequestSchema,
  effective: z.strictObject({ bbox, minZoom: z.number().finite(), maxZoom: z.number().finite() }),
  source: offlineSourceDescriptorSchema,
  requestKey: z.string(),
});
/** Why an offline package job failed or expired, as its row stores it. */
export const offlinePackageJobErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "CAPACITY",
  "GENERATION_FAILED",
  "EXPIRED",
]);
const offlinePackagePreparationBaseSchema = z.strictObject({
  jobId: z.string(),
  request: canonicalOfflinePackageRequestSchema,
  status: z.enum(["preparing", "ready-to-download", "failed", "expired"]),
  packageId: z.string().optional(),
  manifest: offlineMapPackageManifestSchema.optional(),
  errorCode: offlinePackageJobErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
});
export const offlinePackagePreparingSchema = offlinePackagePreparationBaseSchema.extend({
  status: z.literal("preparing"),
  packageId: z.string(),
});
export const offlinePackageReadySchema = offlinePackagePreparationBaseSchema.extend({
  status: z.literal("ready-to-download"),
  packageId: z.string(),
  manifest: offlineMapPackageManifestSchema,
});
export const offlinePackageFailedSchema = offlinePackagePreparationBaseSchema.extend({
  status: z.literal("failed"),
  errorCode: offlinePackageJobErrorCodeSchema,
  errorMessage: z.string(),
});
export const offlinePackageExpiredSchema = offlinePackagePreparationBaseSchema.extend({
  status: z.literal("expired"),
  errorCode: z.literal("EXPIRED"),
  errorMessage: z.string(),
});
export const offlinePackagePreparationSchema = z.discriminatedUnion("status", [
  offlinePackagePreparingSchema,
  offlinePackageReadySchema,
  offlinePackageFailedSchema,
  offlinePackageExpiredSchema,
]);
export const offlinePackageCapabilitySchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    provider: z.literal("openmapx"),
    datasetVersion: z.string(),
    glyphsVersion: z.string(),
    sourceMaxZoom: countSchema,
    sourceBounds: bbox,
  }),
  z.strictObject({
    available: z.literal(false),
    provider: z.literal("openmapx"),
    reason: z.literal("source-unavailable"),
  }),
]);
/** An offline preparation refusal in the error envelope; `code` names the reason. */
export const offlinePackageErrorSchema = z.strictObject({
  error: z.string(),
  code: z.enum([
    "INVALID_PRINCIPAL",
    "INVALID_REQUEST",
    "CAPACITY",
    "PRINCIPAL_QUOTA",
    "SOURCE_UNAVAILABLE",
    "GENERATION_FAILED",
    "EXPIRED",
  ]),
  retryAfterSeconds: countSchema.optional(),
});
export const offlinePrincipalHeadersSchema = z.object({
  "x-offline-package-principal": z.string().regex(/^[a-f0-9]{64}$/),
});
export const offlineArchiveHeadersSchema = z.object({
  range: z.string().optional(),
  "if-range": z.string().optional(),
});
export const offlinePackageParamsSchema = z.strictObject({
  packageId: z.string().regex(/^omp2-[0-9a-f]{64}$/),
});
export const offlineJobParamsSchema = z.strictObject({ jobId: z.string().min(1) });
export const offlineGlyphVersionParamsSchema = z.strictObject({
  version: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
});
export const offlineGlyphParamsSchema = offlineGlyphVersionParamsSchema.extend({
  fontstack: z
    .string()
    .min(1)
    .refine((v) => !v.includes("/"), "invalid fontstack"),
  range: z.string().regex(/^\d+-\d+$/),
});
export const offlineGlyphCatalogSchema = z.record(z.string(), z.array(z.string()));
export type OfflinePackagePreparation = z.infer<typeof offlinePackagePreparationSchema>;
export type OfflinePackageCapability = z.infer<typeof offlinePackageCapabilitySchema>;
