import z from "zod/v4";
import { countSchema, messageProgressSchema, streamErrorSchema, timestampSchema } from "./common";
export const conflationPhaseSchema = z.enum(["extract", "score", "assign", "publish", "complete"]);
export const conflationStatusSchema = z.enum([
  "completed",
  "already_completed",
  "already_running",
  "waiting_for_osm",
  "failed",
]);
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
export const overturePullEventSchema = z.union([
  messageProgressSchema,
  streamErrorSchema,
  z.strictObject({ event: z.literal("done"), ok: z.literal(true), path: z.string() }),
]);
export const overtureSyncResultSchema = z.strictObject({
  release: z.string(),
  path: z.string(),
  conflation: conflationStatusSchema,
  linked: countSchema,
  conflationError: z.string().optional(),
  retention: z
    .strictObject({ retained: z.array(z.string()), removed: z.array(z.string()) })
    .optional(),
});
export const overtureSyncEventSchema = z.union([
  messageProgressSchema,
  streamErrorSchema,
  overtureSyncResultSchema.extend({ event: z.literal("done"), ok: z.literal(true) }),
]);
export const overtureSimpleEventSchema = z.union([
  messageProgressSchema,
  streamErrorSchema,
  z.strictObject({ event: z.literal("done"), ok: z.literal(true) }),
]);
const done = { event: z.literal("done"), linked: countSchema, message: z.string().optional() };
export const overtureConflateEventSchema = z.union([
  messageProgressSchema,
  streamErrorSchema,
  z.strictObject({
    ...done,
    ok: z.literal(true),
    status: z.literal("completed"),
    emitted: countSchema,
    extracted: countSchema,
    candidates: countSchema,
    components: countSchema,
    phaseDurationsMs: durations,
  }),
  z.strictObject({
    ...done,
    ok: z.literal(true),
    status: z.enum(["already_completed", "already_running"]),
  }),
  z.strictObject({
    ...done,
    ok: z.literal(false),
    status: z.literal("waiting_for_osm"),
    pbfPath: z.string(),
  }),
  z.strictObject({
    ...done,
    ok: z.literal(false),
    status: z.literal("failed"),
    phase: conflationPhaseSchema,
    error: z.string(),
  }),
]);
export type OvertureStatus = z.infer<typeof overtureStatusSchema>;
export type OvertureSyncResult = z.infer<typeof overtureSyncResultSchema>;
export type OvertureConflateEvent = z.infer<typeof overtureConflateEventSchema>;
export type OvertureConflateResult = Extract<OvertureConflateEvent, { event: "done" }>;

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
