import { z } from "zod";
import {
  groundStartPackageSchema,
  lngLatSchema,
  localeSchema,
  transitStartPackageSchema,
  unitsSchema,
} from "./mobileProtocol";

/**
 * The persisted active navigation session — native's source of truth.
 *
 * Deliberately a new schema rather than an extension of the browser's
 * ground-only `offlineSession`: transit needs stateful leg progress, a rotating
 * refresh token and scheduled alert identities, and quietly widening the browser
 * schema would make both harder to reason about.
 *
 * Three rules shape it:
 *
 *  - **No location history.** Only the last accepted fix is kept. Keys that
 *    would accumulate a track are rejected outright rather than ignored.
 *  - **Revisions are the ordering mechanism.** Every committed mutation
 *    increments by exactly one, so a stale command cannot overwrite newer state.
 *  - **It expires.** Twenty-four hours, so a forgotten session cannot keep
 *    tracking indefinitely.
 */

export const MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION = 1 as const;
export const MOBILE_NAVIGATION_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Cap on each cue/event ledger, trimmed oldest-first. */
export const MOBILE_SESSION_LEDGER_LIMIT = 512;

const boundedId = z.string().min(1).max(128);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const fixSchema = z
  .object({
    coords: lngLatSchema,
    accuracy: z.number().finite().nonnegative(),
    heading: z.number().finite().nullish(),
    speed: z.number().finite().nullish(),
    timestampMs: safeInteger,
    coasted: z.boolean().optional(),
  })
  .strict();

const ledgerSchema = z
  .object({
    spoken: z.array(boundedId).max(MOBILE_SESSION_LEDGER_LIMIT),
    events: z.array(boundedId).max(MOBILE_SESSION_LEDGER_LIMIT),
  })
  .strict()
  .refine(
    (ledger) =>
      new Set(ledger.spoken).size === ledger.spoken.length &&
      new Set(ledger.events).size === ledger.events.length,
    { message: "cue and event ledgers must not contain duplicates" },
  );

const navTickStateSchema = z
  .object({
    offRouteScore: z.number().finite(),
    lastRerouteAtMs: safeInteger.nullable(),
    rerouteBackoffMs: z.number().finite().nonnegative(),
    spokenCues: z.array(z.string().max(128)).max(2_000),
  })
  .passthrough();

const groundRerouteStateSchema = z
  .object({
    status: z.enum(["idle", "pending", "in-flight", "unavailable", "failed"]),
    requestId: boundedId.optional(),
    attempts: z.number().int().nonnegative().max(64).default(0),
    nextAttemptAtMs: safeInteger.optional(),
    lastFailureCode: z.string().max(64).optional(),
  })
  .strict();

const groundPayloadSchema = z
  .object({
    startPackage: groundStartPackageSchema,
    tickState: navTickStateSchema,
    progress: z.record(z.string(), z.unknown()).nullable(),
    weakGps: z.boolean(),
    offRoute: z.boolean(),
    coasting: z.boolean(),
    currentSpeedLimit: z.number().finite().nullable(),
    coastingAnchor: z
      .object({
        acceptedAtMs: safeInteger,
        alongMeters: z.number().finite().nonnegative(),
        speedMps: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
    reroute: groundRerouteStateSchema,
  })
  .strict();

const transitTickStateSchema = z
  .object({
    currentLegIndex: z.number().int().nonnegative().max(512),
    currentWalkStepIndex: z.number().int().nonnegative().max(10_000),
    phase: z.enum(["walking", "waiting-to-board", "riding", "transferring", "arrived"]),
    lastAcceptedFix: fixSchema.optional(),
    lastProgressAtMs: safeInteger.optional(),
    legEnteredAtMs: safeInteger,
    recoveryUntilMs: safeInteger.optional(),
    spokenCueIds: z.array(boundedId).max(MOBILE_SESSION_LEDGER_LIMIT),
    emittedEventIds: z.array(boundedId).max(MOBILE_SESSION_LEDGER_LIMIT),
    scheduleFallback: z.enum(["inactive", "eligible", "active"]),
    replanRequestedForLeg: z.number().int().nonnegative().max(512).optional(),
  })
  .strict();

const transitPayloadSchema = z
  .object({
    startPackage: transitStartPackageSchema,
    tickState: transitTickStateSchema,
    progress: z.record(z.string(), z.unknown()).nullable(),
    confidence: z.enum(["gps", "schedule", "stale"]),
    /**
     * The rotating live-refresh token. Native is its exclusive consumer; it is
     * stripped from every snapshot, event, notification and diagnostic.
     */
    refreshToken: z.string().max(4_096).nullable(),
    refresh: z
      .object({
        status: z.enum(["ready", "in-flight", "stale", "broken"]),
        generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        requestId: boundedId.optional(),
        nextAttemptAtMs: safeInteger.optional(),
        attempts: z.number().int().nonnegative().max(64).default(0),
      })
      .strict(),
    replan: z
      .object({
        status: z.enum(["idle", "pending", "in-flight", "unavailable", "failed"]),
        requestId: boundedId.optional(),
        generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        attempts: z.number().int().nonnegative().max(64).default(0),
        nextAttemptAtMs: safeInteger.optional(),
      })
      .strict(),
    scheduledAlerts: z
      .array(
        z
          .object({
            id: boundedId,
            legIndex: z.number().int().nonnegative(),
            triggerAtMs: safeInteger,
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

const baseSessionShape = {
  schemaVersion: z.literal(MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION),
  sessionId: boundedId,
  revision: safeInteger,
  status: z.enum(["preparing", "active", "arrived", "stopped", "expired", "error"]),
  startedAtMs: safeInteger,
  updatedAtMs: safeInteger,
  expiresAtMs: safeInteger,
  locale: localeSchema,
  units: unitsSchema,
  connectivity: z.enum(["online", "offline", "unknown"]),
  permissionMode: z.enum(["background", "foreground-only"]),
  cueLedger: ledgerSchema,
  lastAcceptedFix: fixSchema.optional(),
};

const groundSessionSchema = z
  .object({ ...baseSessionShape, kind: z.literal("ground"), payload: groundPayloadSchema })
  .strict();

const transitSessionSchema = z
  .object({ ...baseSessionShape, kind: z.literal("transit"), payload: transitPayloadSchema })
  .strict();

interface SessionTimes {
  startedAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

/**
 * Timestamps must be internally consistent, and no session may outlive the
 * 24-hour cap — that cap is what stops a forgotten session from tracking
 * indefinitely, so it is enforced on read as well as on write.
 */
function hasCoherentLifetime(session: SessionTimes): boolean {
  if (session.updatedAtMs < session.startedAtMs) return false;
  if (session.expiresAtMs <= session.startedAtMs) return false;
  return session.expiresAtMs - session.startedAtMs <= MOBILE_NAVIGATION_SESSION_MAX_AGE_MS;
}

const LIFETIME_MESSAGE = {
  message: "session timestamps must be coherent and within the 24-hour maximum",
};

export const mobileNavigationSessionSchema = z.union([
  groundSessionSchema.refine(hasCoherentLifetime, LIFETIME_MESSAGE),
  transitSessionSchema.refine(hasCoherentLifetime, LIFETIME_MESSAGE),
]);

export type GroundMobileSession = z.infer<typeof groundSessionSchema>;
export type TransitMobileSession = z.infer<typeof transitSessionSchema>;
export type MobileNavigationSession = GroundMobileSession | TransitMobileSession;

/**
 * The only thing that outlives a finished session.
 *
 * Enough for a reloaded page to render an outcome, and nothing more: no route,
 * no fix, no stop name, no cue text, no token.
 */
export const mobileTerminalAckSchema = z
  .object({
    sessionId: boundedId,
    kind: z.enum(["ground", "transit"]),
    finalStatus: z.enum(["arrived", "stopped", "expired", "error"]),
    finalRevision: safeInteger,
    completedAtMs: safeInteger,
  })
  .strict();

export type MobileTerminalAck = z.infer<typeof mobileTerminalAckSchema>;

export type SessionParseResult =
  | { ok: true; session: MobileNavigationSession }
  | { ok: false; code: "unsupported-schema" | "invalid-session" };

/**
 * Parses persisted JSON. Never mutates the input, and always returns a
 * deep copy so a caller cannot accidentally share mutable arrays with storage.
 */
export function parseMobileSession(value: unknown): SessionParseResult {
  const decoded = typeof value === "string" ? safeJsonParse(value) : value;
  if (decoded === undefined) return { ok: false, code: "invalid-session" };

  const version = (decoded as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version !== "number") return { ok: false, code: "invalid-session" };
  if (version !== MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION) {
    return { ok: false, code: "unsupported-schema" };
  }

  const parsed = mobileNavigationSessionSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, code: "invalid-session" };
  return { ok: true, session: structuredClone(parsed.data) as MobileNavigationSession };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Migration dispatch.
 *
 * Version 1 is the first schema, so there is no invented v0 path. An unknown or
 * newer version is reported rather than guessed, so the coordinator can
 * quarantine the record instead of misreading it.
 */
export function migrateMobileSession(value: unknown): SessionParseResult {
  return parseMobileSession(value);
}

export function isMobileSessionExpired(session: MobileNavigationSession, nowMs: number): boolean {
  return nowMs >= session.expiresAtMs;
}

/** Appends to a ledger, dropping the oldest entries beyond the cap. */
export function appendToLedger(ledger: string[], ids: readonly string[]): string[] {
  const next = [...ledger];
  for (const id of ids) if (!next.includes(id)) next.push(id);
  return next.length > MOBILE_SESSION_LEDGER_LIMIT
    ? next.slice(next.length - MOBILE_SESSION_LEDGER_LIMIT)
    : next;
}

export interface RedactedSession {
  kind: "ground" | "transit";
  status: MobileNavigationSession["status"];
  revision: number;
  ageMs: number;
  connectivity: MobileNavigationSession["connectivity"];
  permissionMode: MobileNavigationSession["permissionMode"];
  spokenCueCount: number;
  eventCount: number;
  hasLastFix: boolean;
}

/**
 * What a diagnostic export may contain about a session: shape and counts only.
 * No coordinates, geometry, stop names, instructions, tokens or cue text.
 */
export function redactSessionForDiagnostics(
  session: MobileNavigationSession,
  nowMs: number,
): RedactedSession {
  return {
    kind: session.kind,
    status: session.status,
    revision: session.revision,
    ageMs: Math.max(0, nowMs - session.startedAtMs),
    connectivity: session.connectivity,
    permissionMode: session.permissionMode,
    spokenCueCount: session.cueLedger.spoken.length,
    eventCount: session.cueLedger.events.length,
    hasLastFix: session.lastAcceptedFix !== undefined,
  };
}
