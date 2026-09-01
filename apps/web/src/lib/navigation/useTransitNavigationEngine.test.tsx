// @vitest-environment jsdom

import {
  type FixInput,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
} from "@openmapx/core";
import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixHandler: ((fix: FixInput) => void) | null = null;
vi.mock("../useWatchPosition", () => ({
  useWatchPosition: (_active: boolean, onFix: (f: FixInput) => void) => {
    fixHandler = onFix;
  },
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMapOptional: () => null }));

import { useTransitNavigationEngine } from "./useTransitNavigationEngine";

const leg = (coordinates: [number, number][]): TripLeg =>
  ({
    mode: "bus",
    startTime: "",
    endTime: "",
    from: { name: "board", lat: 0, lng: 0 },
    to: { name: "alight", lat: 0, lng: 0.004 },
    geometry: { type: "LineString", coordinates },
  }) as TripLeg;

/** An itinerary on fresh geometry arrays, so its leg indexes are built here. */
const freshItinerary = (): TripItinerary => ({
  duration: 600,
  startTime: "",
  endTime: "",
  transfers: 0,
  walkDistance: 0,
  legs: [
    leg([
      [0, 0],
      [0.002, 0],
      [0.004, 0],
    ]),
    leg([
      [0.004, 0],
      [0.006, 0],
    ]),
  ],
});

describe("useTransitNavigationEngine itinerary index ownership", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    fixHandler = null;
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });

  afterEach(() => {
    setRouteMatcherCounting(false);
    resetRouteMatcherCounters();
    useNavigationStore.getState().stopNavigation();
  });

  it("indexes each leg once for a whole run of fixes", () => {
    useNavigationStore.getState().startTransitNavigation(freshItinerary());
    renderHook(() => useTransitNavigationEngine());

    act(() => {
      for (let i = 1; i <= 10; i++) {
        fixHandler?.({ coords: [0.0003 * i, 0], accuracy: 5, timestampMs: 1000 * i });
      }
    });

    const counters = readRouteMatcherCounters();
    // Two legs with usable geometry, indexed once — not once per fix.
    expect(counters.preparations).toBe(2);
    // Every fix is snapped onto both legs to find the one being ridden.
    expect(counters.snaps).toBe(20);
    expect(useNavigationStore.getState().transitProgress?.currentLegIndex).toBe(0);
  });

  it("rebuilds only when a replan swaps the itinerary in", () => {
    useNavigationStore.getState().startTransitNavigation(freshItinerary());
    renderHook(() => useTransitNavigationEngine());
    act(() => fixHandler?.({ coords: [0.0005, 0], accuracy: 5, timestampMs: 1000 }));
    expect(readRouteMatcherCounters().preparations).toBe(2);

    act(() => useNavigationStore.getState().replaceItinerary(freshItinerary()));
    act(() => {
      for (let i = 1; i <= 5; i++) {
        fixHandler?.({ coords: [0.0003 * i, 0], accuracy: 5, timestampMs: 2000 + i });
      }
    });

    expect(readRouteMatcherCounters().preparations).toBe(4);
  });
});
