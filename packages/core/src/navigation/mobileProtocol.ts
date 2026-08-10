import { z } from "zod";

/**
 * The complete wire contract between the OpenMapX web UI and the installed
 * mobile shell.
 *
 * Three properties matter more than convenience here:
 *
 *  - **There is no escape hatch.** No `invokeNative(method, args)`, no URL to
 *    fetch, no JavaScript to evaluate, no SQL, no file path, no arbitrary
 *    notification or speech text. A same-origin XSS in the page can reach
 *    whatever this protocol exposes, so it exposes only bounded navigation
 *    commands.
 *  - **Bounds are checked before side effects.** Byte size first, then JSON,
 *    then a strict schema, then aggregate route limits. A message that fails any
 *    stage produces a typed error and changes nothing.
 *  - **Errors carry no input.** Codes are stable and enumerable; the offending
 *    payload, coordinates, geometry and tokens never appear in an error, a log
 *    or a diagnostic.
 *
 * The web app deploys independently of the store binary, so versions are
 * negotiated rather than assumed.
 */

/* --------------------------------------------------------------- limits --- */

/** Serialized message ceiling. Larger input is refused before it is parsed. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Aggregate coordinates across every geometry in one message. */
export const MAX_TOTAL_COORDINATES = 100_000;
/** Aggregate navigation steps across every route in one message. */
export const MAX_TOTAL_STEPS = 10_000;
/** Legs in a single itinerary or route set. */
export const MAX_LEGS = 512;
/** How far a message timestamp may sit from the receiver's clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 512;

/* ------------------------------------------------------------- versions --- */

export const MOBILE_PROTOCOL_MIN = 1;
export const MOBILE_PROTOCOL_MAX = 1;

export interface ProtocolRange {
  min: number;
  max: number;
}

/**
 * Highest version both sides support, or `null` when the ranges do not overlap.
 * A null result must disable installed-app navigation start and ask for a store
 * update — never silently fall back to a second navigation engine.
 */
export function negotiateMobileProtocol(web: ProtocolRange, native: ProtocolRange): number | null {
  const min = Math.max(web.min, native.min);
  const max = Math.min(web.max, native.max);
  return min <= max ? max : null;
}

/* -------------------------------------------------------------- vocabulary */

export const WEB_TO_NATIVE_TYPES = [
  "web.hello",
  "session.prepare",
  "session.start",
  "session.replace",
  "settings.update",
  "snapshot.request",
  "session.stop",
  "session.complete",
  "event.ack",
] as const;

export const NATIVE_TO_WEB_TYPES = [
  "native.hello",
  "permission.state",
  "session.prepared",
  "session.started",
  "session.replaced",
  "session.stopped",
  "snapshot.update",
  "navigation.event",
  "native.error",
] as const;

export type WebToNativeType = (typeof WEB_TO_NATIVE_TYPES)[number];
export type NativeToWebType = (typeof NATIVE_TO_WEB_TYPES)[number];

export interface MobileBridgeEnvelope<TType extends string, TPayload> {
  protocolVersion: number;
  type: TType;
  messageId: string;
  channelNonce: string;
  sessionId?: string;
  revision?: number;
  sentAtMs: number;
  payload: TPayload;
}

/* --------------------------------------------------------------- schemas --- */

const boundedId = z.string().min(1).max(MAX_ID_LENGTH);
const boundedText = z.string().min(1).max(MAX_TEXT_LENGTH);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** `[longitude, latitude]`, matching the shared engine's coordinate order. */
export const lngLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

export const localeSchema = z.enum(["en", "de"]);
export const unitsSchema = z.enum(["metric", "imperial"]);
export const groundModeSchema = z.enum(["driving", "walking", "cycling", "motorcycle"]);

const routeStepSchema = z
  .object({
    instruction: z.string().max(MAX_TEXT_LENGTH).optional(),
    distance: z.number().finite().nonnegative().optional(),
    duration: z.number().finite().nonnegative().optional(),
    name: z.string().max(MAX_TEXT_LENGTH).optional(),
    geometry: z.array(lngLatSchema).optional(),
  })
  // Steps carry engine-specific extras (lanes, verbal cues, exits); passing them
  // through is intentional, but every one is size-bounded by the byte ceiling.
  .passthrough();

const routeSchema = z
  .object({
    distance: z.number().finite().nonnegative(),
    duration: z.number().finite().nonnegative(),
    geometry: z.array(lngLatSchema).min(2),
    steps: z.array(routeStepSchema),
    legs: z.array(z.unknown()).max(MAX_LEGS).optional(),
    mode: z.string().max(64),
    segmentSpeedLimits: z.array(z.number().finite().nonnegative().nullable()).optional(),
    summary: z.string().max(MAX_TEXT_LENGTH).optional(),
  })
  .passthrough();

export const groundNavigationSettingsSchema = z
  .object({
    voiceEnabled: z.boolean(),
    keepScreenOn: z.boolean(),
    voiceTiming: z.enum(["early", "normal", "late"]),
  })
  .strict();

export const groundStartPackageSchema = z
  .object({
    kind: z.literal("ground"),
    route: routeSchema,
    alternatives: z.array(routeSchema).max(8).default([]),
    mode: groundModeSchema,
    destinationWaypoints: z.array(lngLatSchema).min(1).max(64),
    routeProvider: z.string().max(64).optional(),
    routeSelectionIntent: z.enum(["automatic", "userSelected"]),
    routeOptions: z.record(z.string(), z.unknown()).default({}),
    capturedLiveSpeedLimits: z.array(z.number().finite().nullable()).optional(),
    locale: localeSchema,
    units: unitsSchema,
    settings: groundNavigationSettingsSchema,
  })
  .strict();

export const transitLegCaptureSchema = z
  .object({
    legIndex: z.number().int().nonnegative().max(MAX_LEGS),
    tripId: z.string().max(MAX_ID_LENGTH),
    capturedAtMs: safeInteger,
    status: z.enum(["captured", "missing"]),
    stops: z
      .array(
        z
          .object({
            stopId: z.string().max(MAX_ID_LENGTH),
            name: z.string().max(MAX_TEXT_LENGTH),
            lat: z.number().finite().min(-90).max(90),
            lng: z.number().finite().min(-180).max(180),
            platform: z.string().max(64).optional(),
            scheduledPlatform: z.string().max(64).optional(),
            scheduledArrival: z.string().max(64).optional(),
            scheduledDeparture: z.string().max(64).optional(),
            expectedArrival: z.string().max(64).optional(),
            expectedDeparture: z.string().max(64).optional(),
            canceled: z.boolean().optional(),
            departed: z.boolean().optional(),
          })
          .strict(),
      )
      .max(2_000),
  })
  .strict();

export const transitStartPackageSchema = z
  .object({
    kind: z.literal("transit"),
    itinerary: z.record(z.string(), z.unknown()),
    captures: z.array(transitLegCaptureSchema).max(MAX_LEGS).default([]),
    replanOptions: z.record(z.string(), z.unknown()).optional(),
    locale: localeSchema,
    units: unitsSchema,
    settings: z
      .object({
        voiceEnabled: z.boolean(),
        keepScreenOn: z.boolean(),
        alightAlertsEnabled: z.boolean(),
      })
      .strict(),
    itineraryFingerprint: boundedId,
  })
  .strict();

export const navigationStartPackageSchema = z.discriminatedUnion("kind", [
  groundStartPackageSchema,
  transitStartPackageSchema,
]);

export type GroundNavigationStartPackage = z.infer<typeof groundStartPackageSchema>;
export type TransitNavigationStartPackage = z.infer<typeof transitStartPackageSchema>;
export type NavigationStartPackage = z.infer<typeof navigationStartPackageSchema>;
export type TransitLegCapture = z.infer<typeof transitLegCaptureSchema>;

/** What the shell tells the page about itself. Deliberately not a capability grant. */
export const nativeCapabilitiesSchema = z
  .object({
    groundNavigation: z.boolean(),
    transitNavigation: z.boolean(),
    backgroundLocation: z.boolean(),
    localNotifications: z.boolean(),
    speech: z.boolean(),
  })
  .strict();

export type NativeCapabilities = z.infer<typeof nativeCapabilitiesSchema>;

export const permissionStateSchema = z.enum([
  "not-determined",
  "foreground",
  "background",
  "denied",
  "limited",
]);

const envelope = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) =>
  z
    .object({
      protocolVersion: z.number().int().min(1).max(64),
      type: z.literal(type),
      messageId: boundedId,
      channelNonce: boundedId,
      sessionId: boundedId.optional(),
      revision: safeInteger.optional(),
      sentAtMs: safeInteger,
      payload,
    })
    .strict();

export const webToNativeSchema = z.discriminatedUnion("type", [
  envelope(
    "web.hello",
    z
      .object({
        webBuildId: boundedId,
        minProtocolVersion: z.number().int().min(1).max(64),
        maxProtocolVersion: z.number().int().min(1).max(64),
      })
      .strict(),
  ),
  envelope("session.prepare", z.object({ startPackage: navigationStartPackageSchema }).strict()),
  envelope("session.start", z.object({}).strict()),
  envelope("session.replace", z.object({ startPackage: navigationStartPackageSchema }).strict()),
  envelope(
    "settings.update",
    z
      .object({
        voiceEnabled: z.boolean().optional(),
        keepScreenOn: z.boolean().optional(),
        voiceTiming: z.enum(["early", "normal", "late"]).optional(),
        alightAlertsEnabled: z.boolean().optional(),
        locale: localeSchema.optional(),
        units: unitsSchema.optional(),
      })
      .strict(),
  ),
  envelope("snapshot.request", z.object({}).strict()),
  envelope("session.stop", z.object({}).strict()),
  envelope("session.complete", z.object({}).strict()),
  envelope("event.ack", z.object({ eventIds: z.array(boundedId).max(256) }).strict()),
]);

export const nativeToWebSchema = z.discriminatedUnion("type", [
  envelope(
    "native.hello",
    z
      .object({
        shellVersion: boundedId,
        shellBuild: boundedId,
        selectedProtocolVersion: z.number().int().min(1).max(64).nullable(),
        minProtocolVersion: z.number().int().min(1).max(64),
        maxProtocolVersion: z.number().int().min(1).max(64),
        platform: z.enum(["ios", "android"]),
        capabilities: nativeCapabilitiesSchema,
        permission: permissionStateSchema,
        locationDriver: z.enum(["expo", "native"]),
        activeSession: z
          .object({
            sessionId: boundedId,
            revision: safeInteger,
            kind: z.enum(["ground", "transit"]),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  ),
  envelope("permission.state", z.object({ permission: permissionStateSchema }).strict()),
  envelope("session.prepared", z.object({ sessionId: boundedId, revision: safeInteger }).strict()),
  envelope("session.started", z.object({ sessionId: boundedId, revision: safeInteger }).strict()),
  envelope("session.replaced", z.object({ sessionId: boundedId, revision: safeInteger }).strict()),
  envelope(
    "session.stopped",
    z
      .object({
        sessionId: boundedId,
        finalStatus: z.enum(["arrived", "stopped", "expired", "error"]),
        revision: safeInteger,
      })
      .strict(),
  ),
  envelope("snapshot.update", z.object({ snapshot: z.record(z.string(), z.unknown()) }).strict()),
  envelope(
    "navigation.event",
    z
      .object({
        eventId: boundedId,
        event: z.record(z.string(), z.unknown()),
      })
      .strict(),
  ),
  envelope(
    "native.error",
    z.object({ code: boundedText, forMessageId: boundedId.optional() }).strict(),
  ),
]);

export const mobileBridgeMessageSchema = z.union([webToNativeSchema, nativeToWebSchema]);

export type WebToNativeMessage = z.infer<typeof webToNativeSchema>;
export type NativeToWebMessage = z.infer<typeof nativeToWebSchema>;
export type MobileBridgeMessage = z.infer<typeof mobileBridgeMessageSchema>;

/* ---------------------------------------------------------------- parsing --- */

export const PARSE_ERROR_CODES = [
  "payload-too-large",
  "invalid-json",
  "prototype-pollution",
  "invalid-message",
  "wrong-channel",
  "timestamp-out-of-range",
  "too-many-coordinates",
  "too-many-steps",
  "too-many-legs",
] as const;

export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; error: { code: ParseErrorCode } };

const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Rejects prototype-polluting keys anywhere in the decoded value.
 *
 * `JSON.parse` does not assign `__proto__`, but a later structural copy or a
 * spread into an object literal can, so the key is refused outright rather than
 * relied upon to stay inert.
 */
function containsPollutingKey(value: unknown, depth = 0): boolean {
  if (depth > 64 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsPollutingKey(item, depth + 1));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (POLLUTING_KEYS.has(key)) return true;
    if (containsPollutingKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

interface AggregateCounts {
  coordinates: number;
  steps: number;
  legs: number;
}

/** Counts geometry, steps and legs anywhere in the message. */
function countAggregates(value: unknown, counts: AggregateCounts, depth = 0): void {
  if (depth > 64 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) countAggregates(item, counts, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "geometry" && Array.isArray(child)) counts.coordinates += child.length;
    else if (key === "steps" && Array.isArray(child)) counts.steps += child.length;
    else if (key === "legs" && Array.isArray(child)) counts.legs += child.length;
    countAggregates(child, counts, depth + 1);
  }
}

export function enforceAggregateBounds<T>(message: T): ParseResult<T> {
  const counts: AggregateCounts = { coordinates: 0, steps: 0, legs: 0 };
  countAggregates(message, counts);
  if (counts.coordinates > MAX_TOTAL_COORDINATES) {
    return { ok: false, error: { code: "too-many-coordinates" } };
  }
  if (counts.steps > MAX_TOTAL_STEPS) return { ok: false, error: { code: "too-many-steps" } };
  if (counts.legs > MAX_LEGS) return { ok: false, error: { code: "too-many-legs" } };
  return { ok: true, message };
}

export interface ParseOptions {
  expectedNonce?: string;
  /** Receiver clock, injected so the bound is testable. */
  nowMs?: number;
}

/**
 * The single entry point for untrusted bridge input, in both directions.
 *
 * Timestamps are bounds-checked but never used for ordering — session revisions
 * are the only ordering mechanism, because a page can set any clock it likes.
 */
export function parseMobileBridgeMessage(
  raw: string,
  options: ParseOptions = {},
): ParseResult<MobileBridgeMessage> {
  if (typeof raw !== "string") return { ok: false, error: { code: "invalid-message" } };
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
    return { ok: false, error: { code: "payload-too-large" } };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "invalid-json" } };
  }
  if (containsPollutingKey(decoded)) return { ok: false, error: { code: "prototype-pollution" } };

  const parsed = mobileBridgeMessageSchema.safeParse(decoded);
  // Zod's issue list echoes the received value; only the stable code escapes.
  if (!parsed.success) return { ok: false, error: { code: "invalid-message" } };

  if (options.expectedNonce && parsed.data.channelNonce !== options.expectedNonce) {
    return { ok: false, error: { code: "wrong-channel" } };
  }
  if (options.nowMs !== undefined) {
    if (Math.abs(options.nowMs - parsed.data.sentAtMs) > MAX_CLOCK_SKEW_MS) {
      return { ok: false, error: { code: "timestamp-out-of-range" } };
    }
  }
  return enforceAggregateBounds(parsed.data);
}
