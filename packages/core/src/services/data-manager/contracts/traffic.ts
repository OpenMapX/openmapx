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
