import {
  type GroundMobileSession,
  type GroundNavigationStartPackage,
  groundStartPackageSchema,
  MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
  MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION,
  routeFingerprint,
} from "@openmapx/core/navigation";
import type { LocationProfileKind } from "../../location/profiles";

/**
 * Turning a captured route into a session native can own.
 *
 * Everything the engine needs must survive here, and nothing it does not need
 * may. Two rules follow from that:
 *
 *  - **Validate before persisting, and before prompting.** A route with one
 *    geometry point or a mode the engine cannot guide is refused up front, so
 *    the user is never asked for location access for a session that could not
 *    have run.
 *  - **Prepared indexes are caches, not state.** A route matcher and its
 *    cumulative distances are derived from the geometry and rebuilt in
 *    microseconds; persisting them would bloat every write and, worse, let a
 *    stale index outlive the route it indexes.
 */

export const GROUND_MODES = ["driving", "walking", "cycling", "motorcycle"] as const;
export type GroundMode = (typeof GROUND_MODES)[number];

export const MAX_ALTERNATIVES = 8;
export const MAX_DESTINATION_WAYPOINTS = 64;

export type GroundPackageError =
  | "invalid-package"
  | "unsupported-mode"
  | "mode-mismatch"
  | "missing-steps"
  | "invalid-alternative"
  | "missing-destination"
  | "speed-limit-length-mismatch";

export type GroundPackageResult =
  | { ok: true; startPackage: GroundNavigationStartPackage }
  | { ok: false; code: GroundPackageError };

function isGroundMode(mode: string): mode is GroundMode {
  return (GROUND_MODES as readonly string[]).includes(mode);
}

/**
 * Validates a captured package beyond what the wire schema can express.
 *
 * The schema checks shape; this checks coherence — that the route's own mode
 * agrees with the requested one, that alternatives are alternatives *for this
 * journey*, and that a captured speed-limit array actually lines up with the
 * segments it claims to describe. A mismatch there would silently attribute the
 * wrong limit to the wrong road.
 */
export function validateGroundStartPackage(value: unknown): GroundPackageResult {
  const parsed = groundStartPackageSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "invalid-package" };
  const startPackage = parsed.data;

  if (!isGroundMode(startPackage.mode)) return { ok: false, code: "unsupported-mode" };

  // Geometry length, coordinate ranges and aggregate size are already enforced
  // by the shared schema and the bridge's byte and coordinate ceilings, so this
  // function checks only what those cannot: coherence between the parts.
  const { route } = startPackage;
  // A route with no steps has no maneuvers to announce and no step gate to
  // advance; the engine would report progress along a line and never speak.
  if (route.steps.length === 0) return { ok: false, code: "missing-steps" };
  if (route.mode !== startPackage.mode) return { ok: false, code: "mode-mismatch" };

  if (startPackage.destinationWaypoints.length === 0) {
    return { ok: false, code: "missing-destination" };
  }
  if (startPackage.destinationWaypoints.length > MAX_DESTINATION_WAYPOINTS) {
    return { ok: false, code: "invalid-package" };
  }

  if (startPackage.alternatives.length > MAX_ALTERNATIVES) {
    return { ok: false, code: "invalid-alternative" };
  }
  for (const alternative of startPackage.alternatives) {
    // An alternative for a different mode is not an alternative for this
    // journey; following it would silently change how the user is guided.
    if (alternative.mode !== startPackage.mode) return { ok: false, code: "invalid-alternative" };
  }

  const limits = startPackage.capturedLiveSpeedLimits;
  if (limits && limits.length !== route.geometry.length - 1) {
    return { ok: false, code: "speed-limit-length-mismatch" };
  }

  return { ok: true, startPackage };
}

/**
 * How eagerly cues fire, per user preference.
 *
 * Exhaustive and pinned rather than a number from the bridge: an arbitrary
 * multiplier would let the page schedule a cue kilometres early or suppress it
 * entirely, and neither is a preference the user expressed.
 */
export function announceMultiplierFor(timing: "early" | "normal" | "late"): number {
  switch (timing) {
    case "early":
      return 1.35;
    case "normal":
      return 1;
    case "late":
      return 0.75;
  }
}

/** Which qualified location cadence a mode asks the operating system for. */
export function locationProfileForMode(mode: GroundMode): LocationProfileKind {
  switch (mode) {
    case "driving":
      return "driving";
    case "motorcycle":
      return "motorcycle";
    case "cycling":
      return "cycling";
    case "walking":
      return "walking";
  }
}

export interface GroundSessionIdentity {
  sessionId: string;
  locale: "en" | "de";
  units: "metric" | "imperial";
  permissionMode: "background" | "foreground-only";
}

/**
 * Builds revision 1 of a ground session.
 *
 * The package is deep-copied, so a caller that keeps mutating the object it
 * passed cannot reach into persisted state afterwards.
 */
export function createGroundPreparingSession(
  startPackage: GroundNavigationStartPackage,
  identity: GroundSessionIdentity,
  nowMs: number,
): GroundMobileSession {
  return {
    schemaVersion: MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION,
    sessionId: identity.sessionId,
    revision: 1,
    status: "preparing",
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
    locale: identity.locale,
    units: identity.units,
    connectivity: "unknown",
    permissionMode: identity.permissionMode,
    cueLedger: { spoken: [], events: [] },
    kind: "ground",
    payload: {
      startPackage: structuredClone(startPackage),
      tickState: {
        offRouteScore: 0,
        lastRerouteAtMs: null,
        rerouteBackoffMs: 0,
        spokenCues: [],
      },
      progress: null,
      weakGps: false,
      offRoute: false,
      coasting: false,
      currentSpeedLimit: null,
      reroute: { status: "idle", attempts: 0 },
    },
  };
}

/** Identity of the route a session is currently following. */
export function groundRouteFingerprint(session: GroundMobileSession): string {
  return routeFingerprint(session.payload.startPackage.route.geometry);
}
