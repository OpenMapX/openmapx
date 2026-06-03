import type { Route } from "@integrations/routing/types";
import { describe, expect, it } from "vitest";
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
const emptyState: NavTickState = { deviationHistory: [], lastRerouteAtMs: null, spokenCues: [] };

describe("processFix", () => {
  it("rejects fixes worse than the accuracy cap", () => {
    const r = processFix(
      route,
      { coords: [0.001, 0], accuracy: 999, timestampMs: 0 },
      emptyState,
      opts,
    );
    expect(r.progress).toBeNull();
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
    expect(state.deviationHistory.length).toBeGreaterThan(0);
    expect(rerouteFlags.some(Boolean)).toBe(true);
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
});
