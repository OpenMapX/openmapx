import type { Route } from "@integrations/routing/types";
import { describe, expect, it } from "vitest";
import { extractTimeline, type NavRecording, type ReplayStep, replayRecording } from "../recording";
import { simulatePositions } from "../simulatePositions";

const geometry: [number, number][] = [
  [0, 0],
  [0.004, 0],
  [0.008, 0],
];

function makeRoute(over: Partial<Route> = {}): Route {
  return {
    distance: 888,
    duration: 120,
    geometry,
    legs: [],
    mode: "driving",
    steps: [
      { instruction: "Head east", distance: 444, duration: 60, coordinates: geometry.slice(0, 2) },
      { instruction: "Arrive", distance: 444, duration: 60, coordinates: geometry.slice(1, 3) },
    ],
    ...over,
  } as unknown as Route;
}

const fixes = simulatePositions(geometry, { speedMps: 14, intervalMs: 1000 });

const recording: NavRecording = {
  version: 1,
  startedAtMs: fixes[0].timestampMs,
  mode: "driving",
  route: makeRoute(),
  reroutes: [],
  fixes,
};

describe("replayRecording", () => {
  it("drives processFix over every recorded fix, one result per fix", () => {
    const steps = replayRecording(recording);
    expect(steps).toHaveLength(fixes.length);
    expect(steps[0].result.progress).not.toBeNull();
    expect(steps[0].routeIndex).toBe(0);
  });

  it("is deterministic — the same recording replays to identical results", () => {
    expect(replayRecording(recording)).toEqual(replayRecording(recording));
  });

  it("yields a monotonically non-decreasing step index over a full drive (gate)", () => {
    const indices = replayRecording(recording).map((s) => s.result.progress?.currentStepIndex ?? 0);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
    }
    expect(indices.at(-1)).toBe(recording.route.steps.length - 1);
  });

  it("switches to the rerouted route at its boundary", () => {
    const rec: NavRecording = {
      ...recording,
      reroutes: [{ afterFixCount: 2, route: makeRoute({ distance: 900 }) }],
    };
    const steps = replayRecording(rec);
    expect(steps[1].routeIndex).toBe(0);
    expect(steps[2].routeIndex).toBe(1);
  });
});

/** Minimal ReplayStep for exercising the timeline reducer directly. */
function step(
  timestampMs: number,
  o: { stepIndex?: number; offRoute?: boolean; arrived?: boolean; routeIndex?: number } = {},
): ReplayStep {
  return {
    fix: { coords: [0, 0], accuracy: 5, timestampMs },
    routeIndex: o.routeIndex ?? 0,
    result: {
      progress: { currentStepIndex: o.stepIndex ?? 0 },
      offRoute: o.offRoute ?? false,
      arrived: o.arrived ?? false,
    },
  } as unknown as ReplayStep;
}

describe("extractTimeline", () => {
  it("marks the start, step changes and arrival from a replayed drive", () => {
    const types = extractTimeline(replayRecording(recording)).map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("step");
    expect(types).toContain("arrived");
  });

  it("emits off-route, reroute, on-route and signal-lost markers in order", () => {
    const steps = [
      step(0),
      step(1000, { offRoute: true }),
      step(2000, { offRoute: false, routeIndex: 1 }),
      step(15000, { routeIndex: 1 }), // 13 s gap > 10 s threshold
    ];
    expect(extractTimeline(steps).map((e) => e.type)).toEqual([
      "start",
      "offRoute",
      "reroute",
      "onRoute",
      "signalLost",
    ]);
  });

  it("does not emit signal-lost before navigation has started", () => {
    const rejected = (timestampMs: number) =>
      ({
        fix: { coords: [0, 0], accuracy: 999, timestampMs },
        routeIndex: 0,
        result: { progress: null, offRoute: false, arrived: false },
      }) as unknown as ReplayStep;
    const steps = [
      rejected(0),
      rejected(20_000), // 20 s gap, but among accuracy-rejected fixes pre-start
      step(21_000), // first usable fix → start
    ];
    const types = extractTimeline(steps).map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).not.toContain("signalLost");
  });

  it("uses the first fix as the timeline origin (offsetMs)", () => {
    const events = extractTimeline([step(5000), step(6000, { stepIndex: 1 })]);
    expect(events[0].offsetMs).toBe(0);
    expect(events.find((e) => e.type === "step")?.offsetMs).toBe(1000);
  });
});
