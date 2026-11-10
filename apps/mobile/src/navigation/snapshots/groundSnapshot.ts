import {
  type GroundFullSnapshot,
  type GroundMobileSession,
  type GroundProgressSnapshot,
  NATIVE_SNAPSHOT_VERSION,
  routeFingerprint,
} from "@openmapx/core/navigation";

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
 *
 * Both shapes are the shared snapshot contract (`nativeSnapshot` in core), which
 * the page parses with its own, more tolerant schema.
 */

export function groundFullSnapshot(session: GroundMobileSession): GroundFullSnapshot {
  const { startPackage } = session.payload;
  return {
    version: NATIVE_SNAPSHOT_VERSION,
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
    version: NATIVE_SNAPSHOT_VERSION,
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
