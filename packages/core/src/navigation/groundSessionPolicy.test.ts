import { describe, expect, it } from "vitest";
import type { LngLat } from "../types/geometry";
import { cumulativeDistances } from "./deadReckon";
import {
  COAST_START_DELAY_MS,
  canRequestReroute,
  coastedFix,
  EMPTY_REROUTE_CHURN,
  groundSpeedLimit,
  IDLE_REROUTE,
  MAX_COAST_METERS,
  MAX_COAST_MS,
  mayCoast,
  onBackOnRoute,
  onRerouteFailed,
  onRerouteOffline,
  onRerouteRequested,
  onRerouteRetryRequested,
  onRerouteSucceeded,
  REROUTE_CHURN_COOLDOWN_MS,
  REROUTE_CHURN_LIMIT,
  REROUTE_CHURN_WINDOW_MS,
  REROUTE_FAILURES_REPORTED,
  REROUTE_IN_FLIGHT_STALE_MS,
  REROUTE_RETRY_DELAYS_MS,
  REROUTE_RETRY_JITTER_MS,
  type RerouteRuntime,
  recordRerouteSuccess,
  rerouteCandidate,
  rerouteRetryDelayMs,
  VOICE_TIMING_MULTIPLIER,
} from "./groundSessionPolicy";
import { navOptionsForMode } from "./options";
import { nextVoiceCue } from "./voiceCue";

const NOW = 1_700_000_100_000;

describe("voice timing", () => {
  it("moves every cue earlier or later by one fixed factor per preference", () => {
    expect(VOICE_TIMING_MULTIPLIER).toEqual({ early: 1.5, normal: 1, late: 0.6 });
  });

  it("fires the far cue at one and a half times the distance when early, and at six tenths when late", () => {
    const voice = navOptionsForMode("driving").voice;
    const step = { instruction: "Turn left", distance: 5_000, duration: 300 } as never;
    const firstTier = (distance: number, timing: keyof typeof VOICE_TIMING_MULTIPLIER) =>
      nextVoiceCue(step, 1, distance, 0, voice, VOICE_TIMING_MULTIPLIER[timing], [])?.tier ?? null;
    // Find the normal far trigger, then check the others scale from it.
    let normalFar = 0;
    for (let distance = 5_000; distance > 0; distance -= 1) {
      if (firstTier(distance, "normal") === "far") {
        normalFar = distance;
        break;
      }
    }
    expect(normalFar).toBeGreaterThan(0);

    expect(firstTier(Math.floor(normalFar * 1.45), "early")).toBe("far");
    expect(firstTier(Math.ceil(normalFar * 1.55), "early")).toBeNull();
    expect(firstTier(Math.floor(normalFar * 0.55), "late")).not.toBeNull();
    expect(firstTier(normalFar, "late")).toBeNull();
  });
});

describe("groundSpeedLimit", () => {
  const route = {
    segmentSpeedLimits: [50, null, 0],
    steps: [{ speedLimit: 30 }, {}],
  };

  it("prefers the route's segment limit, then the matched limit, then the step's", () => {
    const at = (segmentIndex: number, live: Array<number | null> | null) =>
      groundSpeedLimit({
        mode: "driving",
        route,
        liveSpeedLimits: live,
        segmentIndex,
        stepIndex: 0,
      });

    expect(at(0, [70, 70, 70])).toBe(50);
    expect(at(1, [70, 70, 70])).toBe(70);
    expect(at(1, null)).toBe(30);
  });

  it("never shows a zero placeholder as a limit", () => {
    expect(
      groundSpeedLimit({
        mode: "driving",
        route,
        liveSpeedLimits: [null, null, 0],
        segmentIndex: 2,
        stepIndex: 1,
      }),
    ).toBeNull();
  });

  it.each(["walking", "cycling", "motorcycle"])("shows no limit while %s", (mode) => {
    expect(
      groundSpeedLimit({ mode, route, liveSpeedLimits: null, segmentIndex: 0, stepIndex: 0 }),
    ).toBeNull();
  });
});

describe("coasting", () => {
  const geometry: LngLat[] = Array.from({ length: 200 }, (_, index) => [
    8.68 + index * 0.001,
    50.11,
  ]);
  const cumulative = cumulativeDistances(geometry);
  const anchor = { alongMeters: 500, speedMps: 20, atMs: NOW };

  it("coasts only on route, outside a reroute, while moving", () => {
    expect(mayCoast({ offRoute: false, rerouting: false, speedMps: 12 })).toBe(true);
    expect(mayCoast({ offRoute: true, rerouting: false, speedMps: 12 })).toBe(false);
    expect(mayCoast({ offRoute: false, rerouting: true, speedMps: 12 })).toBe(false);
    expect(mayCoast({ offRoute: false, rerouting: false, speedMps: 0 })).toBe(false);
  });

  it("starts a few seconds after the last real fix", () => {
    expect(coastedFix(anchor, geometry, cumulative, NOW + COAST_START_DELAY_MS - 1)).toBeNull();
    expect(coastedFix(anchor, geometry, cumulative, NOW + COAST_START_DELAY_MS)).toMatchObject({
      accuracy: 1,
      coasted: true,
      timestampMs: NOW + COAST_START_DELAY_MS,
    });
  });

  it("moves on and slows down as the gap grows, then stops", () => {
    const early = coastedFix(anchor, geometry, cumulative, NOW + 5_000);
    const later = coastedFix(anchor, geometry, cumulative, NOW + 60_000);

    expect(later?.coords[0]).toBeGreaterThan(early?.coords[0] ?? Number.POSITIVE_INFINITY);
    expect(later?.speed).toBeLessThan(early?.speed ?? 0);
    expect(coastedFix(anchor, geometry, cumulative, NOW + MAX_COAST_MS)).toBeNull();
  });

  it("never travels further than the coast limit or the end of the route", () => {
    const fast = { ...anchor, speedMps: 80 };
    const fix = coastedFix(fast, geometry, cumulative, NOW + MAX_COAST_MS - 1_000);
    const start = geometry[0];
    const metersPerDegree = (cumulative[1] - cumulative[0]) / 0.001;

    expect(fix).not.toBeNull();
    const travelled = ((fix?.coords[0] ?? 0) - start[0]) * metersPerDegree - anchor.alongMeters;
    expect(travelled).toBeLessThanOrEqual(MAX_COAST_METERS + 1);
    expect(fix?.coords[0]).toBeLessThanOrEqual(geometry[geometry.length - 1][0]);
  });
});

describe("canRequestReroute", () => {
  it("allows a first request, also when connectivity is unknown", () => {
    expect(canRequestReroute(IDLE_REROUTE, EMPTY_REROUTE_CHURN, "online", NOW)).toEqual({
      allow: true,
    });
    expect(canRequestReroute(IDLE_REROUTE, EMPTY_REROUTE_CHURN, "unknown", NOW)).toEqual({
      allow: true,
    });
  });

  it("allows only one request at a time", () => {
    const inFlight = onRerouteRequested(IDLE_REROUTE, "r1", NOW - 5_000);

    expect(canRequestReroute(inFlight, EMPTY_REROUTE_CHURN, "online", NOW)).toEqual({
      allow: false,
      reason: "in-flight",
    });
  });

  it("stops waiting for a request whose answer never came back", () => {
    const inFlight = onRerouteRequested(IDLE_REROUTE, "r1", NOW);

    expect(
      canRequestReroute(inFlight, EMPTY_REROUTE_CHURN, "online", NOW + REROUTE_IN_FLIGHT_STALE_MS),
    ).toEqual({ allow: true });
  });

  it("refuses while offline rather than failing", () => {
    expect(canRequestReroute(IDLE_REROUTE, EMPTY_REROUTE_CHURN, "offline", NOW)).toEqual({
      allow: false,
      reason: "offline",
    });
  });

  it("respects the delay after a failure", () => {
    const failed = onRerouteFailed(IDLE_REROUTE, "network", NOW, 0);

    expect(canRequestReroute(failed, EMPTY_REROUTE_CHURN, "online", NOW + 2_999)).toEqual({
      allow: false,
      reason: "backoff",
    });
    expect(canRequestReroute(failed, EMPTY_REROUTE_CHURN, "online", NOW + 3_000)).toEqual({
      allow: true,
    });
  });

  it("keeps offering a reroute after the last retry, at the longest delay", () => {
    let runtime: RerouteRuntime = IDLE_REROUTE;
    for (let attempt = 0; attempt < REROUTE_FAILURES_REPORTED + 2; attempt += 1) {
      runtime = onRerouteFailed(runtime, "network", NOW, 0);
    }
    const longest = REROUTE_RETRY_DELAYS_MS[REROUTE_RETRY_DELAYS_MS.length - 1];

    expect(runtime).toMatchObject({ status: "failed", attempts: REROUTE_FAILURES_REPORTED });
    expect(canRequestReroute(runtime, EMPTY_REROUTE_CHURN, "online", NOW + longest - 1)).toEqual({
      allow: false,
      reason: "backoff",
    });
    expect(canRequestReroute(runtime, EMPTY_REROUTE_CHURN, "online", NOW + longest)).toEqual({
      allow: true,
    });
  });

  it("refuses during the churn pause", () => {
    const churn = { successAtMs: [], cooldownUntilMs: NOW + REROUTE_CHURN_COOLDOWN_MS };

    expect(canRequestReroute(IDLE_REROUTE, churn, "online", NOW)).toEqual({
      allow: false,
      reason: "churn-cooldown",
    });
    expect(
      canRequestReroute(IDLE_REROUTE, churn, "online", NOW + REROUTE_CHURN_COOLDOWN_MS),
    ).toEqual({ allow: true });
  });

  it("does not let a clock set backwards stretch a wait", () => {
    const later = NOW + 60 * 60_000;

    expect(
      canRequestReroute(
        onRerouteRequested(IDLE_REROUTE, "r1", later),
        EMPTY_REROUTE_CHURN,
        "online",
        NOW,
      ),
    ).toEqual({ allow: true });
    expect(
      canRequestReroute(IDLE_REROUTE, { successAtMs: [], cooldownUntilMs: later }, "online", NOW),
    ).toEqual({ allow: true });
    expect(
      canRequestReroute(
        { status: "pending", attempts: 1, nextAttemptAtMs: later },
        EMPTY_REROUTE_CHURN,
        "online",
        NOW,
      ),
    ).toEqual({ allow: true });
  });
});

describe("reroute transitions", () => {
  it("records the open request and when it was sent", () => {
    expect(onRerouteRequested(IDLE_REROUTE, "r1", NOW)).toEqual({
      status: "in-flight",
      requestId: "r1",
      requestedAtMs: NOW,
      attempts: 0,
    });
  });

  it("schedules the next attempt after a failure, with bounded jitter", () => {
    const failed = onRerouteFailed(onRerouteRequested(IDLE_REROUTE, "r1", NOW), "timeout", NOW, 0);

    expect(failed).toEqual({
      status: "pending",
      attempts: 1,
      nextAttemptAtMs: NOW + REROUTE_RETRY_DELAYS_MS[0],
      lastFailureCode: "timeout",
    });
    expect(rerouteRetryDelayMs(1, 1)).toBe(REROUTE_RETRY_DELAYS_MS[0] + REROUTE_RETRY_JITTER_MS);
    expect(rerouteRetryDelayMs(1, 5)).toBe(REROUTE_RETRY_DELAYS_MS[0] + REROUTE_RETRY_JITTER_MS);
    expect(rerouteRetryDelayMs(1, -5)).toBe(REROUTE_RETRY_DELAYS_MS[0]);
    expect(rerouteRetryDelayMs(99, 0)).toBe(
      REROUTE_RETRY_DELAYS_MS[REROUTE_RETRY_DELAYS_MS.length - 1],
    );
  });

  it("keeps the failure count and code bounded", () => {
    let runtime = IDLE_REROUTE;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      runtime = onRerouteFailed(runtime, "e".repeat(500), NOW, 0);
    }

    expect(runtime.attempts).toBe(REROUTE_FAILURES_REPORTED);
    expect(runtime.lastFailureCode).toHaveLength(64);
  });

  it("lets the user's own retry skip the failure delay, but not an open request or a pause", () => {
    const failed = onRerouteFailed(IDLE_REROUTE, "network", NOW, 0);
    const inFlight = onRerouteRequested(IDLE_REROUTE, "r1", NOW);
    const paused = { successAtMs: [], cooldownUntilMs: NOW + REROUTE_CHURN_COOLDOWN_MS };

    expect(
      canRequestReroute(onRerouteRetryRequested(failed), EMPTY_REROUTE_CHURN, "online", NOW),
    ).toEqual({
      allow: true,
    });
    expect(onRerouteRetryRequested(failed).attempts).toBe(1);
    expect(
      canRequestReroute(onRerouteRetryRequested(inFlight), EMPTY_REROUTE_CHURN, "online", NOW),
    ).toEqual({
      allow: false,
      reason: "in-flight",
    });
    expect(canRequestReroute(onRerouteRetryRequested(failed), paused, "online", NOW)).toEqual({
      allow: false,
      reason: "churn-cooldown",
    });
  });

  it("waits for the network without losing the failure count", () => {
    expect(onRerouteOffline({ status: "in-flight", attempts: 2 })).toEqual({
      status: "unavailable",
      attempts: 2,
    });
  });

  it("starts from scratch after a success or back on route, but not over an open request", () => {
    const inFlight = onRerouteRequested(IDLE_REROUTE, "r1", NOW);

    expect(onRerouteSucceeded()).toEqual(IDLE_REROUTE);
    expect(onBackOnRoute({ status: "failed", attempts: 5 })).toEqual(IDLE_REROUTE);
    expect(onBackOnRoute(inFlight)).toBe(inFlight);
  });
});

describe("recordRerouteSuccess", () => {
  it("pauses after three reroutes in two minutes and starts counting again", () => {
    let churn = EMPTY_REROUTE_CHURN;
    for (let index = 0; index < REROUTE_CHURN_LIMIT; index += 1) {
      churn = recordRerouteSuccess(churn, NOW + index * 10_000);
    }

    const pausedAt = NOW + (REROUTE_CHURN_LIMIT - 1) * 10_000;
    expect(churn).toEqual({
      successAtMs: [],
      cooldownUntilMs: pausedAt + REROUTE_CHURN_COOLDOWN_MS,
    });
    // One more quick success after the pause is not yet churn.
    expect(recordRerouteSuccess(churn, pausedAt + REROUTE_CHURN_COOLDOWN_MS).cooldownUntilMs).toBe(
      undefined,
    );
  });

  it("does not pause for reroutes spread out over time", () => {
    let churn = EMPTY_REROUTE_CHURN;
    for (let index = 0; index < 6; index += 1) {
      churn = recordRerouteSuccess(churn, NOW + index * REROUTE_CHURN_WINDOW_MS);
    }

    expect(churn.cooldownUntilMs).toBeUndefined();
    expect(churn.successAtMs).toEqual([NOW + 5 * REROUTE_CHURN_WINDOW_MS]);
  });
});

describe("rerouteCandidate", () => {
  it("follows the route the server marked active, else the first", () => {
    expect(rerouteCandidate({ routes: ["a", "b"], activeRouteIndex: 1 })).toBe("b");
    expect(rerouteCandidate({ routes: ["a", "b"] })).toBe("a");
  });

  it("offers nothing when the answer has no such route", () => {
    expect(rerouteCandidate({ routes: ["a"], activeRouteIndex: 3 })).toBeUndefined();
    expect(rerouteCandidate({})).toBeUndefined();
  });
});
