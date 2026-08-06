import { describe, expect, it } from "vitest";
import type { Route } from "../../types/routing";
import { navOptionsForMode } from "../options";
import { processFix } from "../processFix";
import { simulatePositions } from "../simulatePositions";
import type { NavTickResult, NavTickState } from "../types";

const geometry: [number, number][] = [
  [0, 0],
  [0.002, 0],
  [0.004, 0],
];

const route = {
  distance: 444,
  duration: 60,
  geometry,
  legs: [],
  mode: "driving",
  steps: [
    { instruction: "Head east", distance: 222, duration: 30, coordinates: geometry.slice(0, 2) },
    { instruction: "Arrive", distance: 222, duration: 30, coordinates: geometry.slice(1, 3) },
  ],
} as unknown as Route;

const opts = navOptionsForMode("driving");
const emptyState: NavTickState = {
  offRouteScore: 0,
  lastRerouteAtMs: null,
  rerouteBackoffMs: 0,
  spokenCues: [],
};

describe("processFix", () => {
  it("rejects fixes worse than the accuracy cap", () => {
    const r = processFix(
      route,
      { coords: [0.001, 0], accuracy: 999, timestampMs: 0 },
      emptyState,
      opts,
    );
    expect(r.progress).toBeNull();
    expect(r.accuracyRejected).toBe(true);
  });

  it("rejects a fix with a non-finite coordinate (would poison the snap)", () => {
    const r = processFix(
      route,
      { coords: [Number.NaN, 0], accuracy: 5, timestampMs: 0 },
      emptyState,
      opts,
    );
    expect(r.progress).toBeNull();
    expect(r.accuracyRejected).toBe(true);
  });

  it("does not flag accuracyRejected for an acceptable fix", () => {
    const r = processFix(
      route,
      { coords: [0.001, 0], accuracy: 5, timestampMs: 1000 },
      emptyState,
      opts,
    );
    expect(r.accuracyRejected).toBe(false);
  });

  it("produces progress for an on-route fix", () => {
    const r = processFix(
      route,
      { coords: [0.001, 0], accuracy: 5, timestampMs: 1000 },
      emptyState,
      opts,
    );
    expect(r.progress).not.toBeNull();
    expect(r.progress?.currentStepIndex).toBe(0);
    expect(r.offRoute).toBe(false);
    expect(r.progress?.etaEpochMs).toBeGreaterThan(1000);
    // Route runs due east, so the travel bearing should be ~90°.
    expect(r.progress?.bearing).toBeCloseTo(90, 0);
  });

  it("exposes the route-geometry segment index of the snapped position", () => {
    // Geometry is [0,0]→[0.002,0]→[0.004,0]: two segments (0 and 1).
    const onFirst = processFix(
      route,
      { coords: [0.001, 0], accuracy: 5, timestampMs: 1000 },
      emptyState,
      opts,
    );
    expect(onFirst.progress?.segmentIndex).toBe(0);
    const onSecond = processFix(
      route,
      { coords: [0.003, 0], accuracy: 5, timestampMs: 1000 },
      emptyState,
      opts,
    );
    expect(onSecond.progress?.segmentIndex).toBe(1);
  });

  it("uses the GPS-reported speed when present", () => {
    const r = processFix(
      route,
      { coords: [0.001, 0], accuracy: 5, timestampMs: 1000, speed: 12.5 },
      emptyState,
      opts,
    );
    expect(r.progress?.speedMps).toBe(12.5);
  });

  it("estimates speed from along-route progress when GPS speed is absent", () => {
    const first = processFix(
      route,
      { coords: [0.001, 0], accuracy: 5, timestampMs: 1000 },
      emptyState,
      opts,
    );
    // ~111 m further east, 1 s later → ~111 m/s.
    const second = processFix(
      route,
      { coords: [0.002, 0], accuracy: 5, timestampMs: 2000 },
      first.nextState,
      opts,
    );
    expect(second.progress?.speedMps).toBeGreaterThan(100);
    expect(second.progress?.speedMps).toBeLessThan(125);
  });

  it("flags reroute after sustained off-route fixes", () => {
    let state: NavTickState = emptyState;
    let last: NavTickResult | undefined;
    const rerouteFlags: boolean[] = [];
    for (const fix of simulatePositions(geometry, {
      stepMeters: 50,
      offsetMeters: 200,
      accuracy: 5,
    })) {
      last = processFix(route, fix, state, opts);
      state = last.nextState;
      rerouteFlags.push(last.needsReroute);
    }
    expect(last?.offRoute).toBe(true);
    expect(state.lastRerouteAtMs).not.toBeNull();
    expect(rerouteFlags.some(Boolean)).toBe(true);
  });

  it("suppresses voice cues while off the route (phantom distance)", () => {
    // ~222 m north of the start: off the route, but it snaps to the start so the
    // distance-to-maneuver would otherwise be in voice-cue range.
    const r = processFix(
      route,
      { coords: [0, 0.002], accuracy: 5, timestampMs: 0 },
      emptyState,
      opts,
    );
    expect(r.offRoute).toBe(true);
    expect(r.voiceCue).toBeNull();
  });

  it("holds the step through a brief jump past the maneuver, advancing only after the exit", () => {
    // Approach the maneuver at the end of step 0 (~222 m).
    const f1 = processFix(
      route,
      { coords: [0.00193, 0], accuracy: 5, timestampMs: 0 },
      emptyState,
      opts,
    );
    expect(f1.progress?.currentStepIndex).toBe(0);
    // ~2 m past it — within the 5 m exit window: must NOT flip to step 1 yet.
    const f2 = processFix(
      route,
      { coords: [0.00202, 0], accuracy: 5, timestampMs: 1000 },
      f1.nextState,
      opts,
    );
    expect(f2.progress?.currentStepIndex).toBe(0);
    // ~10 m past it — beyond the exit: now advance.
    const f3 = processFix(
      route,
      { coords: [0.0021, 0], accuracy: 5, timestampMs: 2000 },
      f2.nextState,
      opts,
    );
    expect(f3.progress?.currentStepIndex).toBe(1);
  });

  it("arrives near the destination", () => {
    const r = processFix(
      route,
      { coords: [0.004, 0], accuracy: 5, timestampMs: 5000 },
      emptyState,
      opts,
    );
    expect(r.arrived).toBe(true);
  });

  it("arrives within the threshold on a route whose final step has 0 distance", () => {
    // Real Valhalla/OSRM routes end with a 0-distance 'arrive' maneuver.
    const geom: [number, number][] = [
      [0, 0],
      [0.0018, 0], // ~200 m east
    ];
    const arriveRoute = {
      distance: 200,
      duration: 30,
      geometry: geom,
      legs: [],
      mode: "driving",
      steps: [
        { instruction: "Head east", distance: 200, duration: 30, coordinates: geom },
        { instruction: "Arrive", distance: 0, duration: 0, coordinates: [geom[1], geom[1]] },
      ],
    } as unknown as Route;
    // ~198 m along → ~2 m from the destination, well inside the 35 m threshold.
    const r = processFix(
      arriveRoute,
      { coords: [0.00178, 0], accuracy: 5, timestampMs: 1000 },
      emptyState,
      opts,
    );
    expect(r.arrived).toBe(true);
  });
});

// A route with geometry but no steps — a limited provider, a malformed
// response, or a restored offline session can all produce `steps: []` on an
// otherwise valid route. Arrival must key off destination distance alone
// (there is no step-advance gate to reach), and the maneuver-announcement
// path must never surface the resulting undefined step.
describe("processFix on a route with no steps (geometry-only)", () => {
  const noStepsGeometry: [number, number][] = [
    [0, 0],
    [0.00899320363724538, 0], // ~1000 m east
  ];
  const noStepsRoute = {
    distance: 1000,
    duration: 100,
    geometry: noStepsGeometry,
    legs: [],
    mode: "driving",
    steps: [],
  } as unknown as Route;

  it("reports full progress and does not arrive at the start", () => {
    const r = processFix(
      noStepsRoute,
      { coords: [0, 0], accuracy: 5, timestampMs: 0 },
      emptyState,
      opts,
    );
    expect(r.progress).not.toBeNull();
    expect(r.progress?.currentStepIndex).toBe(0);
    expect(r.progress?.distanceRemaining).toBeCloseTo(1000, 0);
    expect(r.progress?.durationRemaining).toBeCloseTo(100, 0);
    expect(r.progress?.snapped).toBeDefined();
    expect(r.progress?.alongMeters).toBeCloseTo(0, 0);
    expect(r.progress?.deviationMeters).toBeCloseTo(0, 3);
    expect(r.progress?.segmentIndex).toBe(0);
    expect(r.progress?.etaEpochMs).toBeGreaterThan(0);
    expect(r.offRoute).toBe(false);
    expect(r.needsReroute).toBe(false);
    expect(r.arrived).toBe(false);
    expect(r.voiceCue).toBeNull();
  });

  it("keeps reporting progress without arriving or announcing a maneuver mid-route", () => {
    // ~700 m along → 300 m remaining, inside the driving voice cue's "far"
    // trigger (400 m): without the missing-step guard this would surface a
    // cue carrying an undefined step.
    const r = processFix(
      noStepsRoute,
      { coords: [0.006295242546071764, 0], accuracy: 5, timestampMs: 1000 },
      emptyState,
      opts,
    );
    expect(r.progress?.distanceRemaining).toBeCloseTo(300, 0);
    expect(r.arrived).toBe(false);
    expect(r.voiceCue).toBeNull();
  });

  it("arrives once within the arrival threshold of the destination", () => {
    // ~980 m along → 20 m remaining, inside the 35 m driving arrival threshold.
    const r = processFix(
      noStepsRoute,
      { coords: [0.00881333956450047, 0], accuracy: 5, timestampMs: 2000 },
      emptyState,
      opts,
    );
    expect(r.progress?.distanceRemaining).toBeCloseTo(20, 0);
    expect(r.arrived).toBe(true);
    expect(r.voiceCue).toBeNull();
  });
});
