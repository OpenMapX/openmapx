import z from "zod/v4";
import { timestampSchema } from "./common";

const receipt = z.strictObject({
  observationId: z.string(),
  observationRevision: z.string(),
  sourceId: z.string(),
  graphGeneration: z.string(),
  sourceGraphGeneration: z.string(),
  policyRevision: z.string(),
  validUntil: timestampSchema,
  complete: z.literal(true),
  effect: z.enum(["closure", "speed_cap"]),
  intendedSpans: z.array(
    z.strictObject({
      segment_id: z.string(),
      direction: z.enum(["forward", "reverse"]),
      from_fraction: z.number().finite(),
      to_fraction: z.number().finite(),
    }),
  ),
  edgeKeys: z.array(z.string()),
  sourceLicense: z.string(),
  attribution: z.string().nullable(),
});
export const trafficApplicationSnapshotSchema = z.strictObject({
  mode: z.enum(["shadow", "active"]),
  schemaVersion: z.literal(1),
  writeId: z.string().nullable(),
  engineBootId: z.string().nullable(),
  providerId: z.literal("routing-valhalla"),
  graphGeneration: z.string().nullable(),
  policyRevision: z.string().nullable(),
  validUntil: timestampSchema.nullable(),
  receipts: z.array(receipt),
  writtenAt: timestampSchema.nullable(),
  observationIds: z.array(z.string()),
  resolverVersion: z.string().nullable(),
});
export type TrafficApplicationSnapshot = z.infer<typeof trafficApplicationSnapshotSchema>;

const coordinate = (limit: number) => z.coerce.number().finite().min(-limit).max(limit);

/**
 * A trip's bounding box and travel instant. A box wider than 20 degrees is
 * refused: a longer trip asks per leg or accepts a fallback.
 */
export const plannedTrafficClosuresQuerySchema = z
  .strictObject({
    west: coordinate(180),
    south: coordinate(90),
    east: coordinate(180),
    north: coordinate(90),
    at: timestampSchema,
  })
  .refine((q) => q.west <= q.east && q.south <= q.north, "the box must not be inverted")
  .refine((q) => q.east - q.west <= 20 && q.north - q.south <= 20, "the box is too large");

const directedSample = z.strictObject({
  lon: z.number().finite().min(-180).max(180),
  lat: z.number().finite().min(-90).max(90),
  heading: z.number().finite().min(0).lt(360),
});

/**
 * The bound closures a car trip at `at` must route around, each as directed
 * samples along its closed carriageways. `mode` is the live-traffic cycle's:
 * in `shadow`, a consumer evaluates these without excluding them.
 */
export const plannedTrafficClosuresSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.enum(["shadow", "active"]),
  evaluatedAt: timestampSchema,
  at: timestampSchema,
  policyRevision: z.string(),
  validUntil: timestampSchema,
  closures: z.array(
    z.strictObject({
      id: z.string(),
      source: z.string(),
      localAccess: z.boolean(),
      validUntil: timestampSchema,
      samples: z.array(directedSample).min(1),
    }),
  ),
  unrepresentable: z.number().int().min(0),
});
export type PlannedTrafficClosures = z.infer<typeof plannedTrafficClosuresSchema>;
