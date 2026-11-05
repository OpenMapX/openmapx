import { licensingSchema } from "@openmapx/extension-contracts/licensing-schema";
import { parseLicensing } from "@openmapx/mobility-core/licensing";
import z from "zod/v4";
import { adminCountSchema as count, adminTimestampSchema as timestamp } from "./common";
export const transitStateSummarySchema = z.strictObject({
  transitousRef: z.string().nullable(),
  transitousLockedAt: timestamp.nullable(),
  transitousLockedBy: z.string().nullable(),
  lastSyncAt: timestamp.nullable(),
  lastSyncStatus: z.string().nullable(),
  currentJob: z.strictObject({ jobId: z.string(), startedAt: timestamp }).nullable(),
  feedCount: count,
  feeds: z.strictObject({
    byRegion: z.record(z.string(), count),
    byStatus: z.record(z.string(), count),
  }),
});
export const transitFeedSchema = z.strictObject({
  id: z.string(),
  region: z.string(),
  name: z.string(),
  lastFetchedAt: timestamp.nullable(),
  lastImportedAt: timestamp.nullable(),
  hash: z.string().nullable(),
  validationStatus: z.string().nullable(),
  validationMessage: z.string().nullable(),
  status: z.string(),
});
export const transitFeedsResponseSchema = z.strictObject({
  feeds: z.array(transitFeedSchema),
  total: count,
  limit: count,
  offset: count,
});
export const transitJobSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  triggeredBy: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  metadata: z.json(),
});
export const transitJobsResponseSchema = z.strictObject({
  jobs: z.array(transitJobSchema),
  total: count,
  limit: count,
  offset: count,
});
export const transitJobStageSchema = z.strictObject({
  id: z.string(),
  stage: z.string(),
  status: z.string(),
  startedAt: timestamp,
  finishedAt: timestamp,
  durationMs: count,
  message: z.string().nullable(),
  error: z.json(),
  artifacts: z.json(),
});
export const transitJobDetailSchema = transitJobSchema.extend({
  stages: z.array(transitJobStageSchema),
});
const pagination = {
  offset: z.coerce.number().int().nonnegative().safe().optional(),
};
export const transitFeedsQuerySchema = z.strictObject({
  ...pagination,
  limit: z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .overwrite((value) => Math.min(value, 500))
    .describe("Requested page size; capped at 500")
    .optional(),
  region: z.string().optional(),
  status: z.string().optional(),
});
export const transitJobsQuerySchema = z.strictObject({
  ...pagination,
  limit: z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .overwrite((value) => Math.min(value, 200))
    .describe("Requested page size; capped at 200")
    .optional(),
  kind: z.string().optional(),
});
export const transitCatalogQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  search: z.string().optional(),
  country: z.string().optional(),
});
export const transitCatalogFeedSchema = z.strictObject({
  id: z.string(),
  installedSourceId: z.string().nullable(),
  discoveryIds: z.array(z.string()),
  name: z.string(),
  source: z.enum(["transitous", "mobilitydb", "manual"]),
  countryCode: z.string(),
  url: z.string(),
  licensing: licensingSchema
    .refine((value) => Boolean(parseLicensing(value)), "Invalid licensing")
    .optional(),
  bbox: z
    .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
    .optional(),
  mdbId: z.string().optional(),
  latestDatasetUrl: z.string().optional(),
  latestDatasetHash: z.string().optional(),
  latestDatasetDownloadedAt: z.string().optional(),
  isOfficial: z.boolean().optional(),
  dataType: z.string().optional(),
});
export const transitCatalogResponseSchema = z.strictObject({
  limit: count,
  offset: count,
  sources: z.array(transitCatalogFeedSchema),
  total: count,
});
export const roadConditionsPolicySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  authoritative: z.boolean(),
  evaluatedAt: timestamp,
  validUntil: timestamp.nullable(),
  revision: z.string(),
  disallowedSourceIds: z.array(z.string()),
  /** Sources whose rights are unclear (a permission `unknown`) may be used. */
  allowGreyArea: z.boolean(),
  /** Sources whose licence forbids commercial use may be used. */
  allowNonCommercial: z.boolean(),
});
export type TransitStateSummary = z.infer<typeof transitStateSummarySchema>;
export type TransitFeed = z.infer<typeof transitFeedSchema>;
export type TransitFeedsResponse = z.infer<typeof transitFeedsResponseSchema>;
export type TransitJob = z.infer<typeof transitJobSchema>;
export type TransitJobsResponse = z.infer<typeof transitJobsResponseSchema>;
export type TransitJobStage = z.infer<typeof transitJobStageSchema>;
export type TransitJobDetail = z.infer<typeof transitJobDetailSchema>;
export type TransitCatalogFeed = z.infer<typeof transitCatalogFeedSchema>;
export type TransitCatalogResponse = z.infer<typeof transitCatalogResponseSchema>;
export type RoadConditionsPolicySnapshot = z.infer<typeof roadConditionsPolicySnapshotSchema>;
export type {
  TransitSourceListResult,
  TransitSourceMutationResult,
  TransitSourceRow as TransitSource,
} from "../../../services/data-manager/contracts/transit";

export const transitJobIdParamsSchema = z.strictObject({ id: z.uuid() });
