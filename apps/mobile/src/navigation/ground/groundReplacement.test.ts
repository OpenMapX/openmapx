import type { GroundMobileSession } from "@openmapx/core/navigation";
import { parseMobileSession } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { applyGroundReplacement, validateGroundReplacement } from "./groundReplacement";

const NOW = 1_700_000_100_000;

const GEOMETRY: Array<[number, number]> = Array.from({ length: 40 }, (_, index) => [
  8.68 + index * 0.001,
  50.11,
]);

/** A session with every geometry-indexed value populated. */
function advancedSession(overrides: Partial<GroundMobileSession> = {}): GroundMobileSession {
  const base = groundSessionFixture({ status: "active", revision: 9, ...overrides });
  return {
    ...base,
    lastAcceptedFix: { coords: [8.7, 50.11], accuracy: 5, timestampMs: NOW - 1_000 },
    cueLedger: { spoken: ["old-cue"], events: ["old-event"] },
    payload: {
      ...base.payload,
      startPackage: {
        ...base.payload.startPackage,
        route: { ...base.payload.startPackage.route, geometry: GEOMETRY } as never,
      },
      tickState: {
        offRouteScore: 5,
        lastRerouteAtMs: NOW - 30_000,
        rerouteBackoffMs: 6_000,
        spokenCues: ["step-1:near"],
        committedStepIndex: 3,
        reachedStepEnd: true,
        lastAlongMeters: 900,
      } as never,
      progress: { alongMeters: 900, speedMps: 18, segmentIndex: 12 } as never,
      weakGps: true,
      offRoute: true,
      coasting: true,
      currentSpeedLimit: 50,
      reroute: { status: "in-flight", requestId: "r1", attempts: 2 },
    },
  };
}

function replacement(overrides: Record<string, unknown> = {}) {
  const base = groundSessionFixture().payload.startPackage;
  return {
    ...base,
    route: { ...base.route, geometry: GEOMETRY.slice(0, 20) },
    ...overrides,
  };
}

describe("validateGroundReplacement", () => {
  it("accepts a well-formed replacement for the same mode", () => {
    expect(validateGroundReplacement(advancedSession(), replacement()).ok).toBe(true);
  });

  it("accepts a replacement for a session still preparing", () => {
    const preparing = advancedSession({ status: "preparing" });

    expect(validateGroundReplacement(preparing, replacement()).ok).toBe(true);
  });

  it.each(["arrived", "stopped", "expired", "error"] as const)(
    "refuses a replacement after a %s session",
    (status) => {
      expect(validateGroundReplacement(advancedSession({ status }), replacement())).toEqual({
        ok: false,
        code: "not-active",
      });
    },
  );

  it("refuses a replacement that changes the travel mode", () => {
    // A new mode changes the location cadence, the off-route sensitivity and
    // the voice schedule at once — that is a new session, not a replacement.
    const walking = replacement({
      mode: "walking",
      route: { ...replacement().route, mode: "walking" },
    });

    expect(validateGroundReplacement(advancedSession(), walking)).toEqual({
      ok: false,
      code: "mode-changed",
    });
  });

  it.each([
    ["a route with no steps", { route: { ...replacement().route, steps: [] } }, "missing-steps"],
    [
      "a route whose mode disagrees",
      { route: { ...replacement().route, mode: "cycling" } },
      "mode-mismatch",
    ],
  ])("refuses %s", (_label, overrides, code) => {
    expect(validateGroundReplacement(advancedSession(), replacement(overrides))).toEqual({
      ok: false,
      code,
    });
  });

  it.each([
    ["nothing", undefined],
    ["a string", "route"],
    ["an empty object", {}],
    ["an unknown field", { ...replacement(), sneaky: true }],
  ])("refuses %s", (_label, value) => {
    expect(validateGroundReplacement(advancedSession(), value)).toEqual({
      ok: false,
      code: "invalid-package",
    });
  });
});

describe("applyGroundReplacement", () => {
  it("commits the copied itinerary, resets geometry state and preserves journey history", () => {
    const waypoints: Array<[number, number]> = [
      [8.7, 50.15],
      [8.71, 50.11],
      [8.727, 50.11],
    ];
    const source = replacement({ destinationWaypoints: waypoints });
    const mutation = applyGroundReplacement(advancedSession(), source as never, NOW);
    const next = mutation.session as GroundMobileSession;
    expect(next.revision).toBe(10);
    expect(next.payload.startPackage.route.geometry).toEqual(GEOMETRY.slice(0, 20));
    expect(next.payload.startPackage.destinationWaypoints).toEqual(waypoints);
    expect(next.payload).toMatchObject({
      progress: null,
      offRoute: false,
      weakGps: false,
      coasting: false,
      currentSpeedLimit: null,
      tickState: {
        offRouteScore: 0,
        spokenCues: [],
        rerouteBackoffMs: 6_000,
        lastRerouteAtMs: NOW - 30_000,
      },
      reroute: { status: "idle", attempts: 2 },
    });
    expect(next.payload.tickState.committedStepIndex).toBeUndefined();
    expect(next.payload.tickState.reachedStepEnd).toBeUndefined();
    expect(Object.hasOwn(next, "lastAcceptedFix")).toBe(false);
    expect(next.cueLedger).toEqual({ spoken: ["old-cue"], events: ["old-event"] });
    expect(mutation.effects).toEqual([{ kind: "publish-snapshot", immediate: true }]);
    expect(parseMobileSession(JSON.stringify(next)).ok).toBe(true);
    waypoints[1][0] = 9;
    source.route.geometry.push([9.99, 49.99]);
    expect(next.payload.startPackage.destinationWaypoints[1]).toEqual([8.71, 50.11]);
    expect(next.payload.startPackage.route.geometry).toEqual(GEOMETRY.slice(0, 20));
  });
});
