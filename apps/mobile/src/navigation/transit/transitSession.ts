import {
  freshTransitTickState,
  MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
  MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION,
  type TransitMobileSession,
  type TransitNavigationStartPackage,
  transitStartPackageSchema,
} from "@openmapx/core/navigation";
import type { LocationProfileKind } from "../../location/profiles";

/**
 * Turning a captured itinerary into a session native can own.
 *
 * The rotating refresh token is the delicate part. It arrives inside the
 * captured package, and from the moment the session exists native is its
 * exclusive consumer: it lives in the persisted payload and in an outbound
 * request body, and nowhere else. Every projection strips it.
 */

export type TransitPackageError =
  | "invalid-package"
  | "no-destination"
  | "no-transit-leg"
  | "capture-leg-mismatch";

export type TransitPackageResult =
  | { ok: true; startPackage: TransitNavigationStartPackage }
  | { ok: false; code: TransitPackageError };

interface LegLike {
  mode?: string;
  route?: unknown;
  to?: unknown;
}

/**
 * Validates a captured package beyond what the wire schema can express.
 *
 * The schema checks shape; this checks that the trip is actually navigable —
 * that it ends somewhere, that it contains a ride, and that every capture points
 * at a leg that exists. A capture aimed at the wrong leg would count down the
 * wrong train's stops, which is worse than counting none.
 */
export function validateTransitStartPackage(value: unknown): TransitPackageResult {
  const parsed = transitStartPackageSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "invalid-package" };
  const startPackage = parsed.data;

  const legs = ((startPackage.itinerary as { legs?: LegLike[] }).legs ?? []) as LegLike[];
  if (legs.length === 0 || !legs[legs.length - 1]?.to) {
    return { ok: false, code: "no-destination" };
  }
  if (!legs.some((leg) => leg.mode !== "walking" && leg.route)) {
    return { ok: false, code: "no-transit-leg" };
  }
  for (const capture of startPackage.captures) {
    if (capture.legIndex >= legs.length) return { ok: false, code: "capture-leg-mismatch" };
  }
  return { ok: true, startPackage };
}

export interface TransitSessionIdentity {
  sessionId: string;
  permissionMode: "background" | "foreground-only";
}

/**
 * Builds revision 1 of a transit session.
 *
 * The package is deep-copied so a caller that keeps mutating what it passed
 * cannot reach into persisted state — which for transit includes the token.
 */
export function createTransitPreparingSession(
  startPackage: TransitNavigationStartPackage,
  identity: TransitSessionIdentity,
  nowMs: number,
): TransitMobileSession {
  const itinerary = startPackage.itinerary as { refreshToken?: unknown };
  const refreshToken = typeof itinerary.refreshToken === "string" ? itinerary.refreshToken : null;

  return {
    schemaVersion: MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION,
    sessionId: identity.sessionId,
    revision: 1,
    status: "preparing",
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
    locale: startPackage.locale,
    units: startPackage.units,
    connectivity: "unknown",
    permissionMode: identity.permissionMode,
    cueLedger: { spoken: [], events: [] },
    kind: "transit",
    payload: {
      startPackage: structuredClone(startPackage),
      tickState: freshTransitTickState(nowMs),
      progress: null,
      confidence: "gps",
      refreshToken,
      refresh: { status: refreshToken ? "ready" : "broken", generation: 0, attempts: 0 },
      replan: { status: "idle", generation: 0, attempts: 0 },
      scheduledAlerts: [],
    },
  };
}

/**
 * Which location cadence the current phase deserves.
 *
 * Riding between transfers needs only enough resolution to keep the leg banner
 * honest, and asking for more would spend battery for an hour to no purpose.
 * Approaching an event is when a missed cue actually costs the rider a stop, so
 * the cadence goes back up.
 */
export function transitProfileFor(session: TransitMobileSession): LocationProfileKind {
  const { tickState } = session.payload;

  if (tickState.phase === "walking" || tickState.phase === "transferring") return "walking";
  if (tickState.phase === "waiting-to-board") return "transit-near-event";
  if (tickState.phase === "arrived") return "walking";

  // Riding. Close to the alighting stop, or close in time, is a near-event.
  const capture = session.payload.startPackage.captures.find(
    (entry) => entry.legIndex === tickState.currentLegIndex,
  );
  if (capture && capture.status === "captured" && capture.stops.length > 0) {
    const remaining = capture.stops.filter((stop) => !stop.departed).length;
    if (remaining <= 2) return "transit-near-event";
  }
  return "transit-cruise";
}

/** How close in time counts as approaching, when there are no stops to count. */
export const NEAR_EVENT_SECONDS = 300;

export function transitProfileForTime(
  session: TransitMobileSession,
  nowMs: number,
): LocationProfileKind {
  const byPhase = transitProfileFor(session);
  if (byPhase !== "transit-cruise") return byPhase;

  const legs = (session.payload.startPackage.itinerary as { legs?: Array<{ endTime?: string }> })
    .legs;
  const leg = legs?.[session.payload.tickState.currentLegIndex];
  if (!leg?.endTime) return byPhase;
  const endsAtMs = new Date(leg.endTime).getTime();
  if (!Number.isFinite(endsAtMs)) return byPhase;
  return endsAtMs - nowMs <= NEAR_EVENT_SECONDS * 1_000 ? "transit-near-event" : byPhase;
}
