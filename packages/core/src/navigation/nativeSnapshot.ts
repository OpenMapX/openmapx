import { z } from "zod";

/**
 * What the native session tells the page about itself: a full snapshot that a
 * page can render from scratch, or a progress snapshot carrying only the values
 * that change as the user moves.
 *
 * Each shape has two schemas, because the two sides are held to different
 * standards. The app and the page update independently (store releases on one
 * side, a self-hosted server's deploys on the other), so either may be the
 * newer one.
 *
 *  - The **produced** schemas are what this build's native session must emit:
 *    complete, strict and with every vocabulary closed. The snapshot builders
 *    are typed from them, so a renamed field fails to compile, and a field that
 *    must never reach the page (the raw last fix, a refresh token) fails the
 *    strict parse in the builders' tests.
 *  - The **wire** schemas are what the page accepts. They require only the
 *    identity a page needs to place a snapshot (its type, session, revision and
 *    route or itinerary fingerprint) and check the type of every value they
 *    name, but leave the vocabularies open and let unknown fields through. An
 *    app newer than the page can add a field or a status without the page
 *    refusing everything it sends; the page ignores what it does not know.
 */

const boundedId = z.string().min(1).max(128);
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const indexSchema = z.number().int().nonnegative().max(10_000);
const shortText = z.string().max(64);
const recordSchema = z.record(z.string(), z.unknown());

export const NATIVE_SNAPSHOT_VERSION = 1 as const;

const sessionStatusSchema = z.enum([
  "preparing",
  "active",
  "arrived",
  "stopped",
  "expired",
  "error",
]);
const connectivitySchema = z.enum(["online", "offline", "unknown"]);
const permissionModeSchema = z.enum(["background", "foreground-only"]);
const localeSchema = z.enum(["en", "de"]);
const unitsSchema = z.enum(["metric", "imperial"]);

const groundRerouteSchema = z
  .object({
    status: z.enum(["idle", "pending", "in-flight", "unavailable", "failed"]),
    requestId: boundedId.optional(),
    requestedAtMs: revisionSchema.optional(),
    attempts: z.number().int().nonnegative(),
    nextAttemptAtMs: revisionSchema.optional(),
    lastFailureCode: shortText.optional(),
  })
  .strict();

const groundProgressFields = {
  version: z.literal(NATIVE_SNAPSHOT_VERSION),
  sessionId: boundedId,
  revision: revisionSchema,
  routeFingerprint: boundedId,
  status: sessionStatusSchema,
  progress: recordSchema.nullable(),
  weakGps: z.boolean(),
  offRoute: z.boolean(),
  coasting: z.boolean(),
  currentSpeedLimit: z.number().finite().positive().nullable(),
  connectivity: connectivitySchema,
  reroute: groundRerouteSchema,
};

export const groundProgressSnapshotSchema = z
  .object({ ...groundProgressFields, type: z.literal("progress") })
  .strict();

export const groundFullSnapshotSchema = z
  .object({
    ...groundProgressFields,
    type: z.literal("full"),
    kind: z.literal("ground"),
    mode: z.enum(["driving", "walking", "cycling", "motorcycle"]),
    route: recordSchema,
    alternatives: z.array(recordSchema),
    routeProvider: shortText.optional(),
    routeSelectionIntent: z.enum(["automatic", "userSelected"]),
    settings: z
      .object({
        voiceEnabled: z.boolean(),
        keepScreenOn: z.boolean(),
        voiceTiming: z.enum(["early", "normal", "late"]),
      })
      .strict(),
    locale: localeSchema,
    units: unitsSchema,
    permissionMode: permissionModeSchema,
  })
  .strict();

const liveStatusSchema = z
  .object({
    refresh: z.enum(["ready", "in-flight", "stale", "broken"]),
    hasLiveToken: z.boolean(),
  })
  .strict();

const transitProgressFields = {
  version: z.literal(NATIVE_SNAPSHOT_VERSION),
  sessionId: boundedId,
  revision: revisionSchema,
  itineraryFingerprint: boundedId,
  status: sessionStatusSchema,
  currentLegIndex: indexSchema,
  currentWalkStepIndex: indexSchema,
  phase: z.enum(["walking", "waiting-to-board", "riding", "transferring", "arrived"]),
  confidence: z.enum(["gps", "schedule", "stale"]),
  transitProgress: recordSchema.nullable(),
  connectivity: connectivitySchema,
  liveStatus: liveStatusSchema,
};

export const transitProgressSnapshotSchema = z
  .object({ ...transitProgressFields, type: z.literal("progress") })
  .strict();

export const transitFullSnapshotSchema = z
  .object({
    ...transitProgressFields,
    type: z.literal("full"),
    kind: z.literal("transit"),
    itinerary: recordSchema,
    captures: z.array(recordSchema),
    transitReplanOptions: recordSchema.nullable(),
    settings: z
      .object({
        voiceEnabled: z.boolean(),
        keepScreenOn: z.boolean(),
        alightAlertsEnabled: z.boolean(),
      })
      .strict(),
    locale: localeSchema,
    units: unitsSchema,
    permissionMode: permissionModeSchema,
    alightAlertAvailability: z.enum(["scheduled", "unavailable", "disabled"]),
  })
  .strict();

export type GroundFullSnapshot = z.infer<typeof groundFullSnapshotSchema>;
export type GroundProgressSnapshot = z.infer<typeof groundProgressSnapshotSchema>;
export type TransitFullSnapshot = z.infer<typeof transitFullSnapshotSchema>;
export type TransitProgressSnapshot = z.infer<typeof transitProgressSnapshotSchema>;
export type NativeSnapshot =
  | GroundFullSnapshot
  | GroundProgressSnapshot
  | TransitFullSnapshot
  | TransitProgressSnapshot;

const IDENTITY_FIELDS = new Set([
  "version",
  "type",
  "kind",
  "sessionId",
  "routeFingerprint",
  "itineraryFingerprint",
]);

/**
 * The values a progress snapshot may move. A commit that changes anything else
 * publishes a full snapshot, and a page folds only these into what it holds.
 */
export const NATIVE_SNAPSHOT_HOT_FIELDS: readonly string[] = [
  ...new Set([
    ...Object.keys(groundProgressSnapshotSchema.shape),
    ...Object.keys(transitProgressSnapshotSchema.shape),
  ]),
].filter((field) => !IDENTITY_FIELDS.has(field));

/* ------------------------------------------------------- what pages accept --- */

const openText = z.string().max(64);

const wireCommon = {
  type: z.enum(["full", "progress"]),
  sessionId: boundedId,
  revision: revisionSchema,
  version: z.number().int().positive().optional(),
  status: openText.optional(),
  connectivity: openText.optional(),
  permissionMode: openText.optional(),
  locale: openText.optional(),
  units: openText.optional(),
  settings: recordSchema.optional(),
};

export const groundSnapshotWireSchema = z
  .object({
    ...wireCommon,
    kind: z.literal("ground").optional(),
    routeFingerprint: boundedId,
    mode: openText.optional(),
    route: recordSchema.optional(),
    alternatives: z.array(recordSchema).optional(),
    routeProvider: openText.optional(),
    routeSelectionIntent: openText.optional(),
    progress: recordSchema.nullable().optional(),
    weakGps: z.boolean().optional(),
    offRoute: z.boolean().optional(),
    coasting: z.boolean().optional(),
    currentSpeedLimit: z.number().finite().nullable().optional(),
    reroute: recordSchema.optional(),
  })
  .passthrough();

export const transitSnapshotWireSchema = z
  .object({
    ...wireCommon,
    kind: z.literal("transit").optional(),
    itineraryFingerprint: boundedId,
    itinerary: recordSchema.optional(),
    captures: z.array(recordSchema).optional(),
    transitReplanOptions: recordSchema.nullable().optional(),
    currentLegIndex: indexSchema.optional(),
    currentWalkStepIndex: indexSchema.optional(),
    phase: openText.optional(),
    confidence: openText.optional(),
    transitProgress: recordSchema.nullable().optional(),
    liveStatus: z
      .object({ refresh: openText.optional(), hasLiveToken: z.boolean().optional() })
      .passthrough()
      .optional(),
    alightAlertAvailability: openText.optional(),
  })
  .passthrough();

/**
 * The `snapshot` of a `snapshot.update`: a ground or transit snapshot, or an
 * empty object when there is no session to describe.
 */
export const nativeSnapshotWireSchema = z.union([
  groundSnapshotWireSchema,
  transitSnapshotWireSchema,
  z.object({}).strict(),
]);

export type GroundSnapshotWire = z.infer<typeof groundSnapshotWireSchema>;
export type TransitSnapshotWire = z.infer<typeof transitSnapshotWireSchema>;
export type NativeSnapshotWire = z.infer<typeof nativeSnapshotWireSchema>;
