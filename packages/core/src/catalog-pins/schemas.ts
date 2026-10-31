import { z } from "zod";
import { executionRefSchema } from "../ops/execution-ref";
export const MAX_CATALOG_PIN_BYTES = 512 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.iso.datetime({ offset: true });
export const transitousPinSchema = z.strictObject({
  ref: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*@[0-9a-f]{40}$/),
  submodules: z
    .record(z.string().min(1).max(256), z.string().regex(/^[a-f0-9]{40}$/))
    .refine((v) => Object.keys(v).length <= 128),
  lockedAt: stamp,
  lockedBy: z.string().min(1).max(128),
  comment: z.string().max(512).optional(),
});
export const gbfsPinSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z.literal("mobilitydata-gbfs"),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    url: z.string().max(256),
    sha256: digest,
    lockedAt: stamp,
    lockedBy: z.string().min(1).max(128),
  })
  .refine(
    (v) => v.url === `https://raw.githubusercontent.com/MobilityData/gbfs/${v.commit}/systems.csv`,
    "GBFS URL must pin its exact commit",
  );
export const catalogPinSetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generationId: digest,
  transitous: transitousPinSchema,
  gbfs: gbfsPinSchema,
});
export const catalogPinCommitIdentitySchema = z.strictObject({
  commitId: z.uuid(),
  execution: executionRefSchema,
  proposalId: z.uuid(),
  validationId: z.uuid(),
  diffDigest: digest,
});
export const catalogPinCommitReceiptSchema = z.strictObject({
  version: z.literal(1),
  identity: catalogPinCommitIdentitySchema,
  previousGenerationId: digest.nullable(),
  generationId: digest,
  phase: z.enum(["prepared", "committed", "not_committed", "unknown"]),
  committedAt: stamp.nullable(),
});
export const catalogPinPointerSchema = z.strictObject({
  version: z.literal(1),
  generationId: digest,
  commitId: z.uuid(),
  operationKey: executionRefSchema.shape.operationKey,
  fingerprint: digest,
  committedAt: stamp,
});
export function decodeLegacyPin<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Catalog lock must be an object");
  const { $schema: _compatibility, ...pin } = value as Record<string, unknown>;
  return schema.parse(pin);
}
