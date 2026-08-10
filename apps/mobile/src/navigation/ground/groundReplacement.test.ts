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
  const result = () =>
    applyGroundReplacement(advancedSession(), replacement() as never, NOW)
      .session as GroundMobileSession;

  it("advances exactly one revision", () => {
    expect(result().revision).toBe(10);
  });

  it("adopts the new route", () => {
    expect(result().payload.startPackage.route.geometry).toHaveLength(20);
  });

  it.each([
    ["progress", (s: GroundMobileSession) => s.payload.progress, null],
    ["off route", (s: GroundMobileSession) => s.payload.offRoute, false],
    ["weak GPS", (s: GroundMobileSession) => s.payload.weakGps, false],
    ["coasting", (s: GroundMobileSession) => s.payload.coasting, false],
    ["speed limit", (s: GroundMobileSession) => s.payload.currentSpeedLimit, null],
    ["off-route score", (s: GroundMobileSession) => s.payload.tickState.offRouteScore, 0],
  ])("resets %s, which belonged to the old geometry", (_label, read, expected) => {
    expect(read(result())).toEqual(expected);
  });

  it("resets the step gate", () => {
    const tick = result().payload.tickState as unknown as Record<string, unknown>;

    expect(tick.committedStepIndex).toBeUndefined();
    expect(tick.reachedStepEnd).toBeUndefined();
    expect(tick.spokenCues).toEqual([]);
  });

  it("drops the last accepted fix, which was snapped against the old route", () => {
    const next = result();

    expect(next.lastAcceptedFix).toBeUndefined();
    expect(Object.hasOwn(next, "lastAcceptedFix")).toBe(false);
  });

  it("clears any in-flight reroute", () => {
    expect(result().payload.reroute).toEqual({ status: "idle", attempts: 2 });
  });

  it("keeps the reroute backoff, which describes the journey rather than the road", () => {
    const tick = result().payload.tickState;

    expect(tick.rerouteBackoffMs).toBe(6_000);
    expect(tick.lastRerouteAtMs).toBe(NOW - 30_000);
  });

  it("keeps the cue ledger, whose entries are namespaced by route", () => {
    // Entries for the old route are already unreachable, and clearing them would
    // lose events the page may not have acknowledged yet.
    expect(result().cueLedger).toEqual({ spoken: ["old-cue"], events: ["old-event"] });
  });

  it("publishes a full snapshot immediately", () => {
    const mutation = applyGroundReplacement(advancedSession(), replacement() as never, NOW);

    expect(mutation.effects).toEqual([{ kind: "publish-snapshot", immediate: true }]);
  });

  it("produces a session the shared schema still accepts", () => {
    // A blank `lastAcceptedFix` key would fail a strict parse on the next load.
    const parsed = parseMobileSession(JSON.stringify(result()));

    expect(parsed.ok).toBe(true);
  });

  it("does not share mutable state with the package it adopted", () => {
    const source = replacement();
    const next = applyGroundReplacement(advancedSession(), source as never, NOW)
      .session as GroundMobileSession;

    source.route.geometry.push([9.99, 49.99]);

    expect(next.payload.startPackage.route.geometry).toHaveLength(20);
  });
});
