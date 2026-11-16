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
  it("keeps maneuver distance and gate timing on the same geometry despite provider distance drift", () => {
    const physical: Route = {
      ...route,
      distance: 2640,
      duration: 120,
      geometry: [
        [0, 0],
        [0.00899320363724538, 0],
        [0.01798640727449076, 0],
      ],
      steps: [
        {
          instruction: "Continue",
          distance: 1320,
          duration: 60,
          coordinates: [
            [0, 0],
            [0.00899320363724538, 0],
          ],
        },
        {
          instruction: "Keep left",
          distance: 1320,
          duration: 60,
          coordinates: [
            [0.00899320363724538, 0],
            [0.01798640727449076, 0],
          ],
          maneuver: { type: "fork", modifier: "left" },
        },
      ],
    };
    let state = { ...emptyState };
    for (const [index, meters] of [300, 500, 700, 900, 970, 1000, 1050].entries()) {
      const r = processFix(
        physical,
        {
          coords: [(0.00899320363724538 * meters) / 1000, 0],
          accuracy: 3,
          speed: 25,
          heading: 90,
          timestampMs: index * 1000,
        },
        state,
        opts,
      );
      state = r.nextState;
      expect(r.progress?.currentStepIndex).toBe(meters <= 1000 ? 0 : 1);
      if (meters < 1000) expect(r.progress?.distanceToNextManeuver).toBeCloseTo(1000 - meters, 1);
      expect(r.needsReroute).toBe(false);
    }
  });
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

  it("projects progress, bearing, speed and segment across on-route fixes", () => {
    const r = processFix(
      route,
      { coords: [0.001, 0], accuracy: 5, timestampMs: 1000, speed: 12.5 },
      emptyState,
      opts,
    );
    expect(r.progress).not.toBeNull();
    expect(r.progress?.currentStepIndex).toBe(0);
    expect(r.offRoute).toBe(false);
    expect(r.progress?.etaEpochMs).toBeGreaterThan(1000);
    // Route runs due east, so the travel bearing should be ~90°.
    expect(r.progress?.bearing).toBeCloseTo(90, 0);
    expect(r.accuracyRejected).toBe(false);
    expect(r.progress?.speedMps).toBe(12.5);
    expect(r.progress?.segmentIndex).toBe(0);
    const next = processFix(
      route,
      { coords: [0.003, 0], accuracy: 5, timestampMs: 2000 },
      r.nextState,
      opts,
    );
    expect(next.progress?.segmentIndex).toBe(1);
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
      { coords: [0, 0], accuracy: 5, timestampMs: 1_000_000 },
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
    expect(r.progress?.etaEpochMs).toBeCloseTo(1_100_000, 0);
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

// The final manoeuvre starts the last travelling step; real engines then append
// a 0-distance "arrive" step. The step gate commits to a step only once the
// position is `stepGateExitMeters` past its manoeuvre, so arrival must not wait
// for that when the final stretch is shorter, or the traveller stops on it.
describe("processFix arrival after the final manoeuvre", () => {
  /** East 200 m, turn left, then `finalMeters` north to the destination. */
  function cornerRoute(northDegrees: number, finalMeters: number): Route {
    const g: [number, number][] = [
      [0, 0],
      [0.0018, 0],
      [0.0018, northDegrees],
    ];
    return {
      distance: 200 + finalMeters,
      duration: 30,
      geometry: g,
      legs: [],
      mode: "driving",
      steps: [
        { instruction: "Head east", distance: 200, duration: 28, coordinates: [g[0], g[1]] },
        {
          instruction: "Turn left",
          distance: finalMeters,
          duration: 2,
          coordinates: [g[1], g[2]],
          maneuver: { type: "turn", modifier: "left" },
        },
        {
          instruction: "Arrive",
          distance: 0,
          duration: 0,
          coordinates: [g[2], g[2]],
          maneuver: { type: "arrive" },
        },
      ],
    } as unknown as Route;
  }

  /** Feeds the fixes in order, carrying state, and returns each fix's `arrived`. */
  function arrivals(
    route: Route,
    coords: [number, number][],
    mode: "driving" | "walking" = "driving",
  ): boolean[] {
    const modeOpts = navOptionsForMode(mode);
    let state: NavTickState = emptyState;
    return coords.map((c, i) => {
      const r = processFix(
        route,
        { coords: c, accuracy: 5, speed: 0, timestampMs: i * 1000 },
        state,
        modeOpts,
      );
      state = r.nextState;
      return r.arrived;
    });
  }

  it("arrives on a final stretch shorter than the driving exit margin", () => {
    // 3 m after the turn; the gate would need 5 m.
    const route = cornerRoute(0.000027, 3);
    expect(
      arrivals(route, [
        [0.00135, 0],
        [0.0017, 0],
        [0.00179, 0], // ~1 m before the turn: not yet
        [0.0018, 0.000009], // 1 m past the turn
        [0.0018, 0.000027], // at the destination
      ]),
    ).toEqual([false, false, false, true, true]);
  });

  it("arrives on a walking final stretch shorter than the walking exit margin", () => {
    // 2 m after the turn; the walking gate would need 3 m.
    const route = cornerRoute(0.000018, 2);
    expect(
      arrivals(
        route,
        [
          [0.0017, 0],
          [0.00179, 0],
          [0.0018, 0.000009],
          [0.0018, 0.000018],
        ],
        "walking",
      ),
    ).toEqual([false, false, true, true]);
  });

  it("arrives when stopped just past the final turn inside the arrival radius", () => {
    // Destination 30 m after the turn; the traveller stops 2 m past it, 28 m
    // from the destination (driving radius 35 m) and short of the 5 m exit.
    const route = cornerRoute(0.00027, 30);
    expect(
      arrivals(route, [
        [0.0017, 0],
        [0.00179, 0],
        [0.0018, 0.000018],
        [0.0018, 0.000018],
      ]),
    ).toEqual([false, false, true, true]);
  });

  it("does not arrive on the approach before the final turn, even inside the radius", () => {
    // Destination 10 m around the corner; stopped ~5.6 m before the turn,
    // 11.45 m from the destination with 15.56 m remaining.
    const route = cornerRoute(0.00009, 10);
    expect(
      arrivals(route, [
        [0.0017, 0],
        [0.00175, 0],
        [0.00175, 0],
      ]),
    ).toEqual([false, false, false]);
  });

  it("still arrives normally on a final stretch longer than the exit margin", () => {
    const route = cornerRoute(0.00027, 30);
    expect(
      arrivals(route, [
        [0.0017, 0],
        [0.0018, 0.00009], // 10 m past the turn, 20 m from the destination
        [0.0018, 0.00018],
      ]),
    ).toEqual([false, true, true]);
  });

  it("does not arrive on an earlier leg that passes the destination", () => {
    // Out and back: east 200 m, north 20 m, west 190 m to a destination 20 m
    // north of the first leg.
    const g: [number, number][] = [
      [0, 0],
      [0.0018, 0],
      [0.0018, 0.00018],
      [0.00009, 0.00018],
    ];
    const route = {
      distance: 410,
      duration: 60,
      geometry: g,
      legs: [],
      mode: "driving",
      steps: [
        { instruction: "Head east", distance: 200, duration: 28, coordinates: [g[0], g[1]] },
        {
          instruction: "Turn left",
          distance: 20,
          duration: 4,
          coordinates: [g[1], g[2]],
          maneuver: { type: "turn", modifier: "left" },
        },
        {
          instruction: "Turn left",
          distance: 190,
          duration: 28,
          coordinates: [g[2], g[3]],
          maneuver: { type: "turn", modifier: "left" },
        },
        {
          instruction: "Arrive",
          distance: 0,
          duration: 0,
          coordinates: [g[3], g[3]],
          maneuver: { type: "arrive" },
        },
      ],
    } as unknown as Route;
    expect(
      arrivals(route, [
        [0, 0], // 22.4 m from the destination
        [0.00009, 0], // 20.0 m from the destination
        [0.0005, 0],
      ]),
    ).toEqual([false, false, false]);
  });
});
