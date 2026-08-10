import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import type { TransitLegCapture } from "./mobileProtocol";
import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  type TransitTickInput,
  type TransitTickState,
} from "./processTransitFix";
import type { FixInput } from "./types";

const NOW = 1_700_000_000_000;
const FP = "itinerary-fp";

/** A straight west-to-east line, so "fraction along" is easy to reason about. */
function line(startLng: number, endLng: number, lat = 50.1, points = 11): [number, number][] {
  return Array.from({ length: points }, (_, i) => [
    startLng + ((endLng - startLng) * i) / (points - 1),
    lat,
  ]);
}

function at(coords: [number, number][], fraction: number): [number, number] {
  const index = Math.round(fraction * (coords.length - 1));
  return coords[Math.max(0, Math.min(coords.length - 1, index))];
}

const WALK_A = line(8.6, 8.61);
const RIDE = line(8.61, 8.7);
const WALK_B = line(8.7, 8.71);

function itinerary(): TripItinerary {
  return {
    legs: [
      {
        geometry: { coordinates: WALK_A },
        steps: [{ distanceMeters: 300 }, { distanceMeters: 400 }],
        startTime: new Date(NOW).toISOString(),
        endTime: new Date(NOW + 5 * 60_000).toISOString(),
        from: { stopId: "home" },
        to: { stopId: "board" },
      },
      {
        tripId: "trip-1",
        geometry: { coordinates: RIDE },
        startTime: new Date(NOW + 6 * 60_000).toISOString(),
        endTime: new Date(NOW + 20 * 60_000).toISOString(),
        from: { stopId: "board" },
        to: { stopId: "alight" },
      },
      {
        geometry: { coordinates: WALK_B },
        steps: [{ distanceMeters: 200 }],
        startTime: new Date(NOW + 21 * 60_000).toISOString(),
        endTime: new Date(NOW + 25 * 60_000).toISOString(),
        from: { stopId: "alight" },
        to: { stopId: "work" },
      },
    ],
  } as unknown as TripItinerary;
}

function captures(overrides: Partial<TransitLegCapture> = {}): TransitLegCapture[] {
  return [
    {
      legIndex: 1,
      tripId: "trip-1",
      capturedAtMs: NOW,
      status: "captured",
      stops: [
        { stopId: "board", name: "Board", lat: 50.1, lng: 8.61 },
        { stopId: "mid", name: "Mid", lat: 50.1, lng: 8.65 },
        { stopId: "alight", name: "Alight", lat: 50.1, lng: 8.7 },
      ],
      ...overrides,
    },
  ];
}

function fix(coords: [number, number], timestampMs: number, accuracy = 8): FixInput {
  return { coords, accuracy, timestampMs };
}

function tick(overrides: Partial<TransitTickInput> = {}) {
  const base: TransitTickInput = {
    itinerary: itinerary(),
    captures: captures(),
    state: freshTransitTickState(NOW),
    nowMs: NOW,
    options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FP },
    ...overrides,
  };
  return processTransitFix(base);
}

/** Feeds a sequence of fixes through the engine, threading state. */
function run(
  steps: Array<{ fix?: FixInput; nowMs: number }>,
  start: TransitTickState = freshTransitTickState(NOW),
  overrides: Partial<TransitTickInput> = {},
) {
  let state = start;
  const events = [];
  let last = tick({ state, ...overrides });
  for (const step of steps) {
    last = processTransitFix({
      itinerary: itinerary(),
      captures: captures(),
      state,
      fix: step.fix,
      nowMs: step.nowMs,
      options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FP },
      ...overrides,
    });
    state = last.state;
    events.push(...last.events);
  }
  return { state, events, last };
}

describe("walking legs", () => {
  it("advances walk steps monotonically", () => {
    const { state } = run([
      { fix: fix(at(WALK_A, 0.1), NOW + 1_000), nowMs: NOW + 1_000 },
      { fix: fix(at(WALK_A, 0.6), NOW + 2_000), nowMs: NOW + 2_000 },
    ]);
    expect(state.phase).toBe("walking");
    expect(state.currentWalkStepIndex).toBeGreaterThanOrEqual(1);
  });

  it("never moves a walk step backwards within a leg", () => {
    // 0.6 stays below the advance threshold, so this exercises step ordering
    // within one leg rather than the leg transition.
    const { state } = run([
      { fix: fix(at(WALK_A, 0.6), NOW + 1_000), nowMs: NOW + 1_000 },
      { fix: fix(at(WALK_A, 0.1), NOW + 2_000), nowMs: NOW + 2_000 },
    ]);
    expect(state.currentLegIndex).toBe(0);
    expect(state.currentWalkStepIndex).toBeGreaterThanOrEqual(1);
  });
});

describe("boarding and riding", () => {
  it("waits at the board stop before departure", () => {
    const { state } = run([{ fix: fix(at(RIDE, 0), NOW + 60_000), nowMs: NOW + 60_000 }], {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
    });
    expect(state.phase).toBe("waiting-to-board");
  });

  it("emits board exactly once when the vehicle starts moving", () => {
    const { events, state } = run(
      [
        { fix: fix(at(RIDE, 0.2), NOW + 7 * 60_000), nowMs: NOW + 7 * 60_000 },
        { fix: fix(at(RIDE, 0.3), NOW + 8 * 60_000), nowMs: NOW + 8 * 60_000 },
      ],
      { ...freshTransitTickState(NOW), currentLegIndex: 1, phase: "waiting-to-board" },
    );
    expect(state.phase).toBe("riding");
    expect(events.filter((e) => e.type === "board")).toHaveLength(1);
  });

  it("warns once when one stop remains", () => {
    const { events } = run(
      [
        { fix: fix(at(RIDE, 0.7), NOW + 15 * 60_000), nowMs: NOW + 15 * 60_000 },
        { fix: fix(at(RIDE, 0.72), NOW + 15 * 60_000 + 1_000), nowMs: NOW + 15 * 60_000 + 1_000 },
      ],
      { ...freshTransitTickState(NOW), currentLegIndex: 1, phase: "riding" },
    );
    const warnings = events.filter((e) => e.type === "approaching-alight");
    expect(warnings).toHaveLength(1);
  });
});

describe("leg advancement", () => {
  it("advances at most one leg per tick", () => {
    const { state } = run([{ fix: fix(at(WALK_B, 0.5), NOW + 1_000), nowMs: NOW + 1_000 }]);
    expect(state.currentLegIndex).toBeLessThanOrEqual(1);
  });

  it("does not jump to a geometrically closer future leg", () => {
    // A fix sitting on the final walking leg must not teleport the traveller
    // there while they are still on the first leg.
    const { state } = run([{ fix: fix(at(WALK_B, 0.9), NOW + 1_000), nowMs: NOW + 1_000 }]);
    expect(state.currentLegIndex).toBe(0);
  });

  it("emits a transfer when it does advance", () => {
    const { events } = run([
      { fix: fix(at(WALK_A, 1), NOW + 4 * 60_000), nowMs: NOW + 4 * 60_000 },
    ]);
    expect(events.some((e) => e.type === "transfer")).toBe(true);
  });

  it("emits alight when leaving a ridden leg", () => {
    const { events } = run(
      [{ fix: fix(at(RIDE, 1), NOW + 20 * 60_000), nowMs: NOW + 20 * 60_000 }],
      { ...freshTransitTickState(NOW), currentLegIndex: 1, phase: "riding" },
    );
    expect(events.some((e) => e.type === "alight")).toBe(true);
  });

  it("never regresses once riding progress is established", () => {
    const { state } = run(
      [
        { fix: fix(at(RIDE, 0.6), NOW + 12 * 60_000), nowMs: NOW + 12 * 60_000 },
        { fix: fix(at(WALK_A, 0.5), NOW + 13 * 60_000), nowMs: NOW + 13 * 60_000 },
      ],
      { ...freshTransitTickState(NOW), currentLegIndex: 1, phase: "riding" },
    );
    expect(state.currentLegIndex).toBeGreaterThanOrEqual(1);
  });

  it("allows one narrow recovery to the previous leg", () => {
    const justEntered: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
      legEnteredAtMs: NOW,
    };
    const { state } = run(
      [{ fix: fix(at(WALK_A, 0.3), NOW + 5_000), nowMs: NOW + 5_000 }],
      justEntered,
    );
    expect(state.currentLegIndex).toBe(0);
  });

  it("refuses recovery once the window has passed", () => {
    const settled: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
      legEnteredAtMs: NOW - 5 * 60_000,
    };
    const { state } = run(
      [{ fix: fix(at(WALK_A, 0.3), NOW + 5_000), nowMs: NOW + 5_000 }],
      settled,
    );
    expect(state.currentLegIndex).toBe(1);
  });
});

describe("fix admission", () => {
  it.each([
    ["low accuracy", fix([8.61, 50.1], NOW + 1_000, 500), "low-accuracy"],
    ["invalid coordinates", fix([999, 50.1], NOW + 1_000), "invalid"],
    ["negative accuracy", fix([8.61, 50.1], NOW + 1_000, -1), "invalid"],
  ])("rejects a %s fix", (_label, badFix, reason) => {
    const result = tick({ fix: badFix });
    expect(result.rejectedReason).toBe(reason);
  });

  it("rejects an out-of-order fix", () => {
    const state = {
      ...freshTransitTickState(NOW),
      lastAcceptedFix: fix([8.61, 50.1], NOW + 5_000),
    };
    expect(tick({ state, fix: fix([8.61, 50.1], NOW + 1_000) }).rejectedReason).toBe(
      "out-of-order",
    );
  });

  it("keeps prior state when a fix is rejected", () => {
    const state = { ...freshTransitTickState(NOW), currentLegIndex: 1, phase: "riding" as const };
    const result = tick({ state, fix: fix([8.65, 50.1], NOW + 1_000, 900) });
    expect(result.state.currentLegIndex).toBe(1);
    expect(result.state.phase).toBe("riding");
  });
});

describe("schedule fallback", () => {
  it("stays inactive while fixes arrive", () => {
    const result = tick({ fix: fix(at(WALK_A, 0.2), NOW + 1_000), nowMs: NOW + 1_000 });
    expect(result.state.scheduleFallback).toBe("inactive");
    expect(result.confidence).toBe("gps");
  });

  it("labels progress as schedule-based after a long gap", () => {
    const stale: TransitTickState = {
      ...freshTransitTickState(NOW),
      lastProgressAtMs: NOW,
    };
    const result = tick({ state: stale, nowMs: NOW + 10 * 60_000 });
    expect(result.confidence).toBe("schedule");
  });

  it("advances at most one leg from schedule alone", () => {
    const stale: TransitTickState = { ...freshTransitTickState(NOW), lastProgressAtMs: NOW };
    const result = tick({ state: stale, nowMs: NOW + 60 * 60_000 });
    expect(result.state.currentLegIndex).toBe(1);
  });

  it("never asserts arrival from time alone", () => {
    const stale: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 2,
      lastProgressAtMs: NOW,
    };
    const result = tick({ state: stale, nowMs: NOW + 90 * 60_000 });
    expect(result.state.phase).not.toBe("arrived");
    expect(result.events.some((e) => e.type === "arrival")).toBe(false);
  });

  it("re-anchors and leaves fallback when a real fix returns", () => {
    const fallback: TransitTickState = {
      ...freshTransitTickState(NOW),
      lastProgressAtMs: NOW,
      scheduleFallback: "active",
    };
    const result = tick({
      state: fallback,
      fix: fix(at(WALK_A, 0.3), NOW + 20 * 60_000),
      nowMs: NOW + 20 * 60_000,
    });
    expect(result.state.scheduleFallback).toBe("inactive");
    expect(result.confidence).toBe("gps");
  });
});

describe("missed connections", () => {
  it("requests a replan once for a leg whose departure has passed", () => {
    const waiting: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "waiting-to-board",
    };
    const first = tick({ state: waiting, nowMs: NOW + 30 * 60_000 });
    expect(first.needsReplan).toBe(true);

    const second = processTransitFix({
      itinerary: itinerary(),
      captures: captures(),
      state: first.state,
      nowMs: NOW + 31 * 60_000,
      options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FP },
    });
    expect(second.needsReplan).toBe(false);
  });

  it("does not request a replan while riding", () => {
    const riding: TransitTickState = {
      ...freshTransitTickState(NOW),
      currentLegIndex: 1,
      phase: "riding",
    };
    expect(tick({ state: riding, nowMs: NOW + 30 * 60_000 }).needsReplan).toBe(false);
  });
});

describe("determinism and identity", () => {
  it("never emits the same event twice across ticks", () => {
    const { events } = run([
      { fix: fix(at(WALK_A, 1), NOW + 4 * 60_000), nowMs: NOW + 4 * 60_000 },
      { fix: fix(at(RIDE, 0.2), NOW + 7 * 60_000), nowMs: NOW + 7 * 60_000 },
      { fix: fix(at(RIDE, 0.3), NOW + 8 * 60_000), nowMs: NOW + 8 * 60_000 },
      { fix: fix(at(RIDE, 0.9), NOW + 18 * 60_000), nowMs: NOW + 18 * 60_000 },
    ]);
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds event ids from structure, never from a stop name", () => {
    const { events } = run(
      [{ fix: fix(at(RIDE, 1), NOW + 20 * 60_000), nowMs: NOW + 20 * 60_000 }],
      { ...freshTransitTickState(NOW), currentLegIndex: 1, phase: "riding" },
    );
    for (const event of events) {
      expect(event.id).toContain(FP);
      expect(event.id).not.toContain("Alight");
      expect(event.id).not.toContain("Board");
    }
  });

  it("does not mutate the state it was given", () => {
    const state = freshTransitTickState(NOW);
    const before = JSON.stringify(state);
    tick({ state, fix: fix(at(WALK_A, 0.5), NOW + 1_000), nowMs: NOW + 1_000 });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("produces identical output for identical input", () => {
    const args = {
      state: freshTransitTickState(NOW),
      fix: fix(at(WALK_A, 0.4), NOW + 1_000),
      nowMs: NOW + 1_000,
    };
    expect(JSON.stringify(tick(args))).toBe(JSON.stringify(tick(args)));
  });

  it("survives serialization between ticks, as process death would force", () => {
    const first = tick({ fix: fix(at(WALK_A, 0.4), NOW + 1_000), nowMs: NOW + 1_000 });
    const revived = JSON.parse(JSON.stringify(first.state)) as TransitTickState;
    const continuous = processTransitFix({
      itinerary: itinerary(),
      captures: captures(),
      state: first.state,
      fix: fix(at(WALK_A, 0.8), NOW + 2_000),
      nowMs: NOW + 2_000,
      options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FP },
    });
    const restarted = processTransitFix({
      itinerary: itinerary(),
      captures: captures(),
      state: revived,
      fix: fix(at(WALK_A, 0.8), NOW + 2_000),
      nowMs: NOW + 2_000,
      options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FP },
    });
    expect(JSON.stringify(restarted.state)).toBe(JSON.stringify(continuous.state));
  });
});

describe("monotonic properties over jittered traces", () => {
  it("holds across 100 deterministic traces", () => {
    for (let seed = 0; seed < 100; seed++) {
      let state = freshTransitTickState(NOW);
      let previousLeg = 0;
      for (let step = 0; step < 20; step++) {
        // Deterministic pseudo-jitter: repeatable, no fuzz dependency.
        const jitter = (((seed * 37 + step * 17) % 21) - 10) / 100_000;
        const fraction = step / 19;
        const coords: [number, number] = [8.6 + fraction * 0.11, 50.1 + jitter];
        const result = processTransitFix({
          itinerary: itinerary(),
          captures: captures(),
          state,
          fix: fix(coords, NOW + step * 30_000),
          nowMs: NOW + step * 30_000,
          options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FP },
        });
        const next = result.state;
        expect(next.currentLegIndex - previousLeg).toBeLessThanOrEqual(1);
        expect(new Set(next.emittedEventIds).size).toBe(next.emittedEventIds.length);
        previousLeg = next.currentLegIndex;
        state = next;
      }
    }
  });
});
