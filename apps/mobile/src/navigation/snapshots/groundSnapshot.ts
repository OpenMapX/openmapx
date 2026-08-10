import type { GroundMobileSession } from "@openmapx/core/navigation";
import { routeFingerprint } from "@openmapx/core/navigation";

/**
 * What the page is told about a ground session.
 *
 * Two shapes, because they answer different questions. A **full** snapshot says
 * "here is everything, start from this" and carries the route; a **progress**
 * snapshot says "you already have the route, here is where the user now is" and
 * carries only the values that change every second. Sending geometry at 1 Hz
 * would be pointless traffic; sending only deltas after a reload would leave the
 * page rendering nothing.
 *
 * Neither carries the raw last fix. The page needs the *snapped* position to
 * draw a puck on a route, and it is already inside `progress`; the raw
 * coordinate adds nothing it can use and is the most sensitive value the session
 * holds. Destination waypoints, routing options and any refresh material stay
 * native-side for the same reason.
 */

export const GROUND_SNAPSHOT_VERSION = 1 as const;

export interface GroundFullSnapshot {
  version: typeof GROUND_SNAPSHOT_VERSION;
  type: "full";
  sessionId: string;
  revision: number;
  status: GroundMobileSession["status"];
  kind: "ground";
  mode: string;
  routeFingerprint: string;
  route: unknown;
  alternatives: unknown[];
  routeProvider?: string;
  routeSelectionIntent: "automatic" | "userSelected";
  progress: unknown;
  weakGps: boolean;
  offRoute: boolean;
  coasting: boolean;
  currentSpeedLimit: number | null;
  settings: unknown;
  locale: "en" | "de";
  units: "metric" | "imperial";
  connectivity: GroundMobileSession["connectivity"];
  permissionMode: GroundMobileSession["permissionMode"];
  reroute: unknown;
}

export interface GroundProgressSnapshot {
  version: typeof GROUND_SNAPSHOT_VERSION;
  type: "progress";
  sessionId: string;
  revision: number;
  routeFingerprint: string;
  status: GroundMobileSession["status"];
  progress: unknown;
  weakGps: boolean;
  offRoute: boolean;
  coasting: boolean;
  currentSpeedLimit: number | null;
  connectivity: GroundMobileSession["connectivity"];
  reroute: unknown;
}

export type GroundSnapshot = GroundFullSnapshot | GroundProgressSnapshot;

export function groundFullSnapshot(session: GroundMobileSession): GroundFullSnapshot {
  const { startPackage } = session.payload;
  return {
    version: GROUND_SNAPSHOT_VERSION,
    type: "full",
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status,
    kind: "ground",
    mode: startPackage.mode,
    routeFingerprint: routeFingerprint(startPackage.route.geometry),
    // Deep-copied, so a consumer mutating what it received cannot reach into
    // persisted state through a shared array.
    route: structuredClone(startPackage.route),
    alternatives: structuredClone(startPackage.alternatives),
    ...(startPackage.routeProvider ? { routeProvider: startPackage.routeProvider } : {}),
    routeSelectionIntent: startPackage.routeSelectionIntent,
    progress: structuredClone(session.payload.progress),
    weakGps: session.payload.weakGps,
    offRoute: session.payload.offRoute,
    coasting: session.payload.coasting,
    currentSpeedLimit: session.payload.currentSpeedLimit,
    settings: structuredClone(startPackage.settings),
    locale: session.locale,
    units: session.units,
    connectivity: session.connectivity,
    permissionMode: session.permissionMode,
    reroute: structuredClone(session.payload.reroute),
  };
}

export function groundProgressSnapshot(session: GroundMobileSession): GroundProgressSnapshot {
  return {
    version: GROUND_SNAPSHOT_VERSION,
    type: "progress",
    sessionId: session.sessionId,
    revision: session.revision,
    routeFingerprint: routeFingerprint(session.payload.startPackage.route.geometry),
    status: session.status,
    progress: structuredClone(session.payload.progress),
    weakGps: session.payload.weakGps,
    offRoute: session.payload.offRoute,
    coasting: session.payload.coasting,
    currentSpeedLimit: session.payload.currentSpeedLimit,
    connectivity: session.connectivity,
    reroute: structuredClone(session.payload.reroute),
  };
}

/* ------------------------------------------------------ the web's side --- */

export interface SnapshotView {
  sessionId: string;
  revision: number;
  routeFingerprint: string;
  full: GroundFullSnapshot;
}

export type ApplyResult =
  | { ok: true; view: SnapshotView }
  | { ok: false; reason: "need-full-snapshot" };

/**
 * How a consumer folds a snapshot into what it is showing.
 *
 * Lives here rather than in the web app because both sides have to agree on it
 * exactly, and a disagreement is invisible until the page is drawing a puck on
 * the wrong road. The rules are deliberately unforgiving: a delta for a
 * different route, for a different session, or for a revision that did not move
 * forward is refused, and refusing means asking for a full snapshot rather than
 * guessing.
 */
export function applyGroundSnapshot(
  current: SnapshotView | null,
  incoming: GroundSnapshot,
): ApplyResult {
  if (incoming.type === "full") {
    return {
      ok: true,
      view: {
        sessionId: incoming.sessionId,
        revision: incoming.revision,
        routeFingerprint: incoming.routeFingerprint,
        full: incoming,
      },
    };
  }

  // A delta with nothing to apply it to is not an error, but it is not enough.
  if (!current) return { ok: false, reason: "need-full-snapshot" };
  if (incoming.sessionId !== current.sessionId) return { ok: false, reason: "need-full-snapshot" };
  if (incoming.routeFingerprint !== current.routeFingerprint) {
    // The route changed underneath the delta, so its progress refers to a line
    // this consumer does not have.
    return { ok: false, reason: "need-full-snapshot" };
  }
  if (incoming.revision <= current.revision) return { ok: false, reason: "need-full-snapshot" };

  return {
    ok: true,
    view: {
      ...current,
      revision: incoming.revision,
      full: {
        ...current.full,
        revision: incoming.revision,
        status: incoming.status,
        progress: incoming.progress,
        weakGps: incoming.weakGps,
        offRoute: incoming.offRoute,
        coasting: incoming.coasting,
        currentSpeedLimit: incoming.currentSpeedLimit,
        connectivity: incoming.connectivity,
        reroute: incoming.reroute,
      },
    },
  };
}
