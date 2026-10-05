// @vitest-environment jsdom

import {
  apiClient,
  type FixInput,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
} from "@openmapx/core";
import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixHandler: ((fix: FixInput) => void) | null = null;
vi.mock("../useWatchPosition", () => ({
  useWatchPosition: (_active: boolean, onFix: (f: FixInput) => void) => {
    fixHandler = onFix;
  },
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMapOptional: () => null }));

import { renderHookWithQuery } from "@/test/query";
import { useTransitNavigationEngine } from "./useTransitNavigationEngine";

const renderEngine = () => renderHookWithQuery(() => useTransitNavigationEngine());

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
    renderEngine();

    act(() => {
      for (let i = 1; i <= 10; i++) {
        fixHandler?.({ coords: [0.0003 * i, 0], accuracy: 5, timestampMs: 1000 * i });
      }
    });

    const counters = readRouteMatcherCounters();
    // Two legs with usable geometry, indexed once — not once per fix.
    expect(counters.preparations).toBe(2);
    // Each fix is snapped onto the current and next leg only, never the whole trip.
    expect(counters.snaps).toBe(40);
    expect(useNavigationStore.getState().transitProgress?.currentLegIndex).toBe(0);
  });

  it("rebuilds only when a replan swaps the itinerary in", () => {
    useNavigationStore.getState().startTransitNavigation(freshItinerary());
    renderEngine();
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

function missedTrip(): TripItinerary {
  const trip = freshItinerary();
  trip.legs[0].tripId = "missed";
  trip.legs[0].startTime = "2020-01-01T00:00:00Z";
  trip.legs[0].endTime = "2020-01-01T00:10:00Z";
  return trip;
}

describe("transit replan request ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useNavigationStore.getState().stopNavigation();
  });

  it.each(["new trip", "replacement", "unmount"])(
    "ignores an old success after %s",
    async (change) => {
      let resolve: (value: unknown) => void = () => {};
      const get = vi.spyOn(apiClient, "get").mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      useNavigationStore.getState().startTransitNavigation(missedTrip());
      const view = renderEngine();
      act(() => fixHandler?.({ coords: [0, 0], accuracy: 5, timestampMs: Date.now() }));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      const expected = freshItinerary();
      act(() => {
        if (change === "unmount") view.unmount();
        else if (change === "replacement") useNavigationStore.getState().replaceItinerary(expected);
        else {
          useNavigationStore.getState().stopNavigation();
          useNavigationStore.getState().startTransitNavigation(expected);
        }
      });
      const before = useNavigationStore.getState().itinerary;
      await act(async () => resolve({ data: { itineraries: [freshItinerary()] } }));
      expect(useNavigationStore.getState().itinerary).toBe(before);
    },
  );

  it("does not clear a new trip's reroute flag when an old request fails", async () => {
    let reject: (reason: Error) => void = () => {};
    const get = vi.spyOn(apiClient, "get").mockImplementation(
      () =>
        new Promise((_r, j) => {
          reject = j;
        }),
    );
    useNavigationStore.getState().startTransitNavigation(missedTrip());
    renderEngine();
    act(() => fixHandler?.({ coords: [0, 0], accuracy: 5, timestampMs: Date.now() }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    act(() => {
      useNavigationStore.getState().startTransitNavigation(freshItinerary());
      useNavigationStore.getState().setTransitRerouteNeeded(true);
    });
    await act(async () => reject(new Error("old request")));
    expect(useNavigationStore.getState().transitRerouteNeeded).toBe(true);
  });
});

/** A walk north to a bus stop at the origin, then the ride east from it. */
function walkThenRide(): TripItinerary {
  const stop = { name: "Blücherplatz", lat: 0, lng: 0, stopId: "mo:de:05334:1:1:1" };
  return {
    duration: 900,
    startTime: "",
    endTime: "",
    transfers: 0,
    walkDistance: 300,
    legs: [
      {
        mode: "walking",
        startTime: new Date(Date.now()).toISOString(),
        endTime: new Date(Date.now() + 20 * 60_000).toISOString(),
        from: { name: "START", lat: -0.003, lng: 0 },
        to: stop,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, -0.003],
            [0, 0],
          ],
        },
      },
      {
        mode: "bus",
        tripId: "52",
        startTime: new Date(Date.now() + 25 * 60_000).toISOString(),
        endTime: new Date(Date.now() + 40 * 60_000).toISOString(),
        from: stop,
        to: { name: "Bushof", lat: 0, lng: 0.02, stopId: "mo:de:05334:2:1:1" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.02, 0],
          ],
        },
      },
    ],
  } as TripItinerary;
}

describe("useTransitNavigationEngine stop areas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useNavigationStore.getState().stopNavigation();
  });

  it("starts the boarding banner on entering the stop's platform, not at its point", async () => {
    // A 70 m bus platform running south of the stop pole.
    const platform = {
      type: "line" as const,
      coordinates: [
        [0, 0],
        [0, -0.0006],
      ] as [number, number][],
      bufferMeters: 4,
    };
    const getOptional = vi
      .spyOn(apiClient, "getOptional")
      .mockImplementation(async (path: unknown) =>
        String(path).includes(encodeURIComponent("mo:de:05334:1:1:1"))
          ? {
              data: {
                stopId: "mo:de:05334:1:1:1",
                platform: [platform],
                station: [],
                source: "osm",
              },
            }
          : null,
      );
    useNavigationStore.getState().startTransitNavigation(walkThenRide());
    renderEngine();
    await waitFor(() => expect(getOptional).toHaveBeenCalled());
    await act(async () => {});

    // At the platform's far end: 60 m short of the pole, beyond the default circle.
    act(() => fixHandler?.({ coords: [0.00001, -0.00054], accuracy: 5, timestampMs: Date.now() }));
    expect(useNavigationStore.getState().transitProgress).toMatchObject({
      currentLegIndex: 1,
      phase: "waiting-to-board",
    });
  });

  it("without the platform's shape, the same spot is still the walk", () => {
    vi.spyOn(apiClient, "getOptional").mockResolvedValue(null);
    useNavigationStore.getState().startTransitNavigation(walkThenRide());
    renderEngine();
    act(() => fixHandler?.({ coords: [0.00001, -0.00054], accuracy: 5, timestampMs: Date.now() }));
    expect(useNavigationStore.getState().transitProgress?.currentLegIndex).toBe(0);
  });

  it("keeps the rider's leg when a realtime refresh swaps the itinerary object", () => {
    vi.spyOn(apiClient, "getOptional").mockResolvedValue(null);
    const trip = walkThenRide();
    useNavigationStore.getState().startTransitNavigation(trip);
    renderEngine();
    act(() => fixHandler?.({ coords: [0, 0.00005], accuracy: 5, timestampMs: Date.now() }));
    expect(useNavigationStore.getState().transitProgress?.currentLegIndex).toBe(1);

    act(() => useNavigationStore.getState().updateItinerary({ ...trip, refreshToken: "next" }));
    act(() => fixHandler?.({ coords: [0, 0.00005], accuracy: 5, timestampMs: Date.now() + 1 }));
    expect(useNavigationStore.getState().transitProgress).toMatchObject({
      currentLegIndex: 1,
      phase: "waiting-to-board",
    });
  });
});
