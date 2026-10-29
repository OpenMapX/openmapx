import z from "zod/v4";
import { AMBIENT_GENERATION_PATTERN, validateAmbientRegion } from "../../../ambient-places-region";
import { countSchema, timestampSchema } from "./common";
export const ambientRegionSchema = z
  .strictObject({
    name: z.string().min(1).max(80),
    bounds: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
    ]),
    coverage: z.enum(["germany", "planet"]).optional(),
  })
  .refine((value) => {
    try {
      validateAmbientRegion(value);
      return true;
    } catch {
      return false;
    }
  }, "invalid ambient region");
const generation = z.string().regex(new RegExp(AMBIENT_GENERATION_PATTERN));
export const ambientManifestSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  attributionPrecision: z.enum(["captured-fields", "legacy-aggregate"]).optional(),
  policyVersion: countSchema,
  generation,
  publishedAt: timestampSchema,
  region: ambientRegionSchema,
  placeCount: countSchema,
  enabled: z.boolean(),
  sources: z.strictObject({
    osm: z.strictObject({
      region: z.string(),
      epoch: z.string(),
      publishedAt: timestampSchema,
      count: countSchema,
    }),
    overture: z
      .strictObject({
        region: z.string(),
        release: z.string(),
        publishedAt: timestampSchema,
        count: countSchema,
      })
      .nullable(),
  }),
});
export const ambientBuildProgressSchema = z.strictObject({
  phase: z.enum(["osm", "overture", "validate"]),
  processed: countSchema,
  batches: countSchema,
  placeCount: countSchema,
});
export const ambientPlanetCheckpointSchema = ambientBuildProgressSchema.extend({
  legacyAttribution: z.boolean().optional(),
  osmType: z.string(),
  osmId: z.string(),
  gers: z.string(),
  osmProcessed: countSchema,
  overtureProcessed: countSchema,
  osmCount: countSchema,
  overtureCount: countSchema,
});
export const ambientPlanetCandidateSchema = z.strictObject({
  generation,
  status: z.enum(["running", "failed", "completed"]),
  checkpoint: ambientPlanetCheckpointSchema,
  error: z.string().nullable(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const ambientPlacesStatusSchema = z.strictObject({
  active: ambientManifestSchema.nullable(),
  attribution: z
    .strictObject({
      formatVersion: z.union([z.literal(1), z.literal(2)]),
      precision: z.enum(["captured-fields", "legacy-aggregate"]),
      rebuildRequired: z.boolean(),
    })
    .nullable()
    .optional(),
  previous: z.string().nullable(),
  building: z.boolean(),
  lastError: z.string().nullable(),
  startedAt: timestampSchema.nullable().optional(),
  finishedAt: timestampSchema.nullable().optional(),
  progress: z.union([ambientPlanetCheckpointSchema, ambientBuildProgressSchema]).nullable(),
  candidate: ambientPlanetCandidateSchema.nullable(),
});
export const ambientGenerationRequestSchema = z.strictObject({ generation });
export const ambientEnabledRequestSchema = z.strictObject({ enabled: z.boolean() });
export type AmbientPlacesStatus = z.infer<typeof ambientPlacesStatusSchema>;
export type AmbientManifest = z.infer<typeof ambientManifestSchema>;
export type AmbientBuildProgress = z.infer<typeof ambientBuildProgressSchema>;
export type AmbientPlanetCandidate = z.infer<typeof ambientPlanetCandidateSchema>;
