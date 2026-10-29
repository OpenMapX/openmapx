import z from "zod/v4";
import { countSchema, streamErrorSchema, timestampSchema } from "./common";

const sharedStatus = {
  ok: z.literal(true),
  epoch: z.string().nullable(),
  status: z.enum(["building", "ready", "failed"]),
  placeCount: countSchema,
  startedAt: timestampSchema.nullable(),
  publishedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
  lastError: z.string().nullable(),
  building: z.boolean(),
};
export const searchIndexStatusSchema = z.strictObject({
  ...sharedStatus,
  region: z.string(),
  sourcePath: z.string().nullable(),
  sourceFingerprint: z.string().nullable(),
  currentFingerprint: z.string().nullable(),
  termCount: countSchema,
  stale: z.boolean(),
});
export const notablePlacesStatusSchema = z.strictObject({
  ...sharedStatus,
  source: z.string().nullable(),
  minSitelinks: countSchema.nullable(),
  nameCount: countSchema,
});
export const searchIndexBuildResultSchema = z.strictObject({
  region: z.string(),
  epoch: z.string(),
  sourceFingerprint: z.string(),
  placeCount: countSchema,
  termCount: countSchema,
});
export const notablePlacesBuildResultSchema = z.strictObject({
  epoch: z.string(),
  source: z.string(),
  minSitelinks: countSchema,
  placeCount: countSchema,
  nameCount: countSchema,
});
export const searchIndexEventSchema = z.union([
  streamErrorSchema,
  z.strictObject({
    event: z.literal("progress"),
    stage: z.enum(["resolve", "extract", "insert", "index", "validate", "publish", "complete"]),
    message: z.string(),
    placeCount: countSchema.optional(),
    termCount: countSchema.optional(),
  }),
  searchIndexBuildResultSchema.extend({ event: z.literal("done"), ok: z.literal(true) }),
]);
export const notablePlacesEventSchema = z.union([
  streamErrorSchema,
  z.strictObject({
    event: z.literal("progress"),
    stage: z.enum(["places", "names", "descriptions", "index", "validate", "publish", "complete"]),
    message: z.string(),
    placeCount: countSchema.optional(),
    nameCount: countSchema.optional(),
  }),
  notablePlacesBuildResultSchema.extend({ event: z.literal("done"), ok: z.literal(true) }),
]);
export type SearchIndexStatus = z.infer<typeof searchIndexStatusSchema>;
export type NotablePlacesStatus = z.infer<typeof notablePlacesStatusSchema>;
export type SearchIndexBuildResult = z.infer<typeof searchIndexBuildResultSchema>;
export type NotablePlacesBuildResult = z.infer<typeof notablePlacesBuildResultSchema>;

export type SearchIndexBuildProgress = Omit<
  Extract<z.infer<typeof searchIndexEventSchema>, { event: "progress" }>,
  "event"
>;
export type SearchIndexBuildStage = SearchIndexBuildProgress["stage"];
export type NotablePlacesBuildProgress = Omit<
  Extract<z.infer<typeof notablePlacesEventSchema>, { event: "progress" }>,
  "event"
>;
export type NotablePlacesBuildStage = NotablePlacesBuildProgress["stage"];
