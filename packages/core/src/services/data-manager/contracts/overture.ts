import z from "zod/v4";
import { countSchema, timestampSchema } from "./common";
export const conflationPhaseSchema = z.enum(["extract", "score", "assign", "publish", "complete"]);
const durations = z.partialRecord(conflationPhaseSchema, countSchema);
export const overtureStatusSchema = z.strictObject({
  ok: z.literal(true),
  release: z.string(),
  region: z.string(),
  placeCount: countSchema,
  status: z.enum(["pending", "running", "completed", "failed", "waiting_for_osm"]),
  phase: conflationPhaseSchema,
  attemptCount: countSchema,
  sourceFingerprint: z.string().nullable(),
  emittedCount: countSchema.nullable(),
  extractedCount: countSchema.nullable(),
  processedCount: countSchema.nullable(),
  candidateCount: countSchema.nullable(),
  componentCount: countSchema.nullable(),
  assignmentCursor: countSchema.nullable(),
  stagedLinkCount: countSchema.nullable(),
  linkedCount: countSchema.nullable(),
  scoreCursorH3: z.string().nullable(),
  scoreCursorType: z.string().nullable(),
  scoreCursorId: countSchema.nullable(),
  phaseDurationsMs: durations,
  lastError: z.string().nullable(),
  startedAt: timestampSchema.nullable(),
  attemptStartedAt: timestampSchema.nullable(),
  phaseStartedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  workspaceCleanedAt: timestampSchema.nullable(),
  releaseFilesPrunedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
  heartbeatAgeMs: countSchema,
  stalled: z.boolean(),
});
export type OvertureStatus = z.infer<typeof overtureStatusSchema>;

const recoveryActionSchema = z.strictObject({
  allowed: z.boolean(),
  reason: z.string().nullable(),
});
export const overtureRecoverySchema = z.strictObject({
  region: z.string(),
  busy: z.boolean(),
  osmAvailable: z.boolean(),
  downloadedRelease: z.string().nullable(),
  installedRelease: z.string().nullable(),
  actions: z.strictObject({
    "overture-pull": recoveryActionSchema,
    "overture-ingest": recoveryActionSchema,
    "overture-extract": recoveryActionSchema,
    "overture-conflate": recoveryActionSchema,
    "overture-restart": recoveryActionSchema,
  }),
});
export type OvertureRecoveryStatus = z.infer<typeof overtureRecoverySchema>;
