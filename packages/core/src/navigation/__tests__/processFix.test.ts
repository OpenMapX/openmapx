import { describe, expect, it } from "vitest";
import type { Route } from "../../types/routing";
import { cumulativeDistances, positionAt } from "../deadReckon";
import { navOptionsForMode } from "../options";
import { processFix } from "../processFix";
import { simulatePositions } from "../simulatePositions";
import type { FixInput, NavTickResult, NavTickState } from "../types";

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

describe("processFix speed fallback", () => {
  const longGeometry: [number, number][] = [
    [0, 0],
    [0.1, 0],
  ];
  const cum = cumulativeDistances(longGeometry);
  const longRoute = { ...route, geometry: longGeometry, distance: cum[1], steps: [] };

  function driver() {
    let state = emptyState;
    return (alongMeters: number, timestampMs: number, extra: Partial<FixInput> = {}) => {
      const result = processFix(
        longRoute,
        {
          coords: positionAt(longGeometry, cum, alongMeters).point,
          timestampMs,
          accuracy: 20,
          speed: null,
          ...extra,
        },
        state,
        opts,
      );
      state = result.nextState;
      return result.progress?.speedMps;
    };
  }

  it("estimates steady motorway speed through alternating position noise", () => {
    const fix = driver();
    for (let i = 0; i < 24; i++) {
      const speed = fix(3000 + 30 * i + (i % 2 ? 20 : -20), i * 1000);
      if (i >= 8) {
        expect(speed).toBeGreaterThan(24);
        expect(speed).toBeLessThan(36);
      }
    }
  });

  it("downweights an accepted but inaccurate position jump", () => {
    const fix = driver();
    for (let i = 0; i < 10; i++) fix(3000 + 30 * i, i * 1000, { accuracy: 5 });
    const speed = fix(3500, 10_000, { accuracy: 200 });
    expect(speed).toBeGreaterThan(25);
    expect(speed).toBeLessThan(35);
    expect(fix(3330, 11_000, { accuracy: 5 })).toBeCloseTo(30, 0);
  });

  it("takes a reported stop immediately instead of filtering it", () => {
    const fix = driver();
    fix(3000, 1000, { speed: 30 });
    expect(fix(3030, 2000, { speed: 0 })).toBe(0);
  });

  it("does not invent motion when reported stops alternate with missing speed", () => {
    const fix = driver();
    for (let i = 0; i < 24; i++) {
      const speed = fix(3000 + (i % 2 ? 20 : -20), i * 1000, { speed: i % 2 ? null : 0 });
      expect(speed).toBeLessThan(2);
    }
  });

  it.each([5, 20])(
    "preserves a reported stop through missing speed at %s m accuracy",
    (accuracy) => {
      const fix = driver();
      for (let i = 0; i < 12; i++) fix(3000 + 30 * i, i * 1000, { speed: 30, accuracy });
      fix(3360, 12_000, { speed: 0, accuracy });
      for (let i = 13; i <= 24; i++) expect(fix(3360, i * 1000, { accuracy })).toBeLessThan(2);
    },
  );

  it("lets position evidence replace an old reported stop when moving again", () => {
    const fix = driver();
    fix(3000, 0, { speed: 0 });
    let speed: number | undefined;
    for (let i = 1; i <= 10; i++) speed = fix(3000 + 30 * i, i * 1000);
    expect(speed).toBeGreaterThan(25);
    expect(speed).toBeLessThan(35);
  });

  it("settles to a stop when reported speed is unavailable", () => {
    const fix = driver();
    for (let i = 0; i <= 10; i++) fix(3000 + 30 * i, i * 1000);
    let speed: number | undefined;
    for (let i = 11; i <= 23; i++) speed = fix(3300, i * 1000);
    expect(speed).toBeLessThan(1.5);
  });

  it("uses real fixes to resume after coasting", () => {
    const fix = driver();
    fix(3000, 1000, { speed: 30 });
    fix(3030, 2000);
    fix(3300, 5000, { speed: 25, coasted: true });
    expect(fix(3150, 6000)).toBeCloseTo(30, 3);
  });

  it.each([1000, 500])(
    "does not let a fix at %s replace the latest speed evidence",
    (timestamp) => {
      const fix = driver();
      fix(3000, 0);
      fix(3030, 1000);
      fix(3200, timestamp);
      expect(fix(3060, 2000)).toBeCloseTo(30, 3);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back for non-finite reported speed %s",
    (speed) => {
      const fix = driver();
      fix(3000, 0);
      expect(fix(3030, 1000, { speed })).toBeCloseTo(30, 3);
    },
  );
});

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

  describe.each([true, false])("destination proximity with steps=%s", (withSteps) => {
    const arrivalRoute = { ...route, steps: withSteps ? route.steps : [] };

    it("waits for a real fix after coasting reaches the destination", () => {
      const coasted = processFix(
        arrivalRoute,
        { coords: [0.004, 0], accuracy: 1, timestampMs: 30_000, coasted: true },
        emptyState,
        opts,
      );
      expect(coasted.progress?.distanceRemaining).toBe(0);
      expect(coasted.arrived).toBe(false);

      const real = processFix(
        arrivalRoute,
        { coords: [0.004, 0], accuracy: 5, timestampMs: 31_000 },
        coasted.nextState,
        opts,
      );
      expect(real.arrived).toBe(true);
    });

    it.each([
      { name: "on a parallel road", coords: [0.004, 0.01] as [number, number] },
      { name: "beyond the destination", coords: [0.014, 0] as [number, number] },
      {
        name: "outside arrival range but inside reroute range",
        coords: [0.004, 0.00036] as [number, number],
      },
    ])("does not arrive $name when projected onto the endpoint", ({ coords }) => {
      const result = processFix(
        arrivalRoute,
        { coords, accuracy: 5, timestampMs: 5000 },
        emptyState,
        opts,
      );
      expect(result.progress?.distanceRemaining).toBe(0);
      expect(result.arrived).toBe(false);
    });

    it("arrives with a small lateral offset inside the arrival threshold", () => {
      const result = processFix(
        arrivalRoute,
        { coords: [0.004, 0.00018], accuracy: 5, timestampMs: 5000 },
        emptyState,
        opts,
      );
      expect(result.arrived).toBe(true);
    });
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
