import type { GroundMobileSession, MobileNavigationSession } from "@openmapx/core/navigation";

/**
 * A minimal but genuinely schema-valid session.
 *
 * Tests build from this rather than from a hand-written object literal so that a
 * tightening of the shared schema surfaces here once, instead of as a dozen
 * separately-drifting fixtures.
 */
export function groundSessionFixture(
  overrides: Partial<GroundMobileSession> = {},
): GroundMobileSession {
  const startedAtMs = 1_700_000_000_000;
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    revision: 1,
    status: "preparing",
    startedAtMs,
    updatedAtMs: startedAtMs,
    expiresAtMs: startedAtMs + 60 * 60_000,
    locale: "en",
    units: "metric",
    connectivity: "online",
    permissionMode: "background",
    cueLedger: { spoken: [], events: [] },
    kind: "ground",
    payload: {
      startPackage: {
        kind: "ground",
        route: {
          distance: 1_200,
          duration: 300,
          geometry: [
            [8.68, 50.11],
            [8.69, 50.12],
          ],
          // One real step, because a route with none has no maneuver to
          // announce and no step gate to advance — the engine would report
          // progress along a line and never speak.
          steps: [
            {
              instruction: "Head north on Beispielstraße",
              distance: 1_200,
              duration: 300,
              name: "Beispielstraße",
              geometry: [
                [8.68, 50.11],
                [8.69, 50.12],
              ],
            },
          ],
          mode: "driving",
        },
        alternatives: [],
        mode: "driving",
        destinationWaypoints: [[8.69, 50.12]],
        routeSelectionIntent: "automatic",
        routeOptions: {},
        locale: "en",
        units: "metric",
        settings: { voiceEnabled: true, keepScreenOn: true, voiceTiming: "normal" },
      },
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
    ...overrides,
  };
}

/** Advances a session by exactly one revision, the way a committed mutation must. */
export function nextRevision(
  session: MobileNavigationSession,
  overrides: Partial<MobileNavigationSession> = {},
): MobileNavigationSession {
  return {
    ...session,
    revision: session.revision + 1,
    updatedAtMs: session.updatedAtMs + 1_000,
    ...overrides,
  } as MobileNavigationSession;
}
