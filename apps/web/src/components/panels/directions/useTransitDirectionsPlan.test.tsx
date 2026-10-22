import { apiClient, useDirectionsStore } from "@openmapx/core";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient } from "@/test";
import { useTransitPlan as realUseTransitPlan } from "../../../../../../packages/core/src/hooks/transit/useTransitPlan";
import {
  type TransitDirectionsSnapshot,
  useTransitDirectionsPlan,
} from "./useTransitDirectionsPlan";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  chain: vi.fn(),
  germany: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useTransitPlan: (...args: unknown[]) => mocks.plan(...args),
  useTransitChainPlan: (...args: unknown[]) => mocks.chain(...args),
  useRouteInGermany: (...args: unknown[]) => mocks.germany(...args),
  useTransitPlanningCapabilities: () => mocks.capabilities(),
}));

function snapshot(overrides: Partial<TransitDirectionsSnapshot> = {}): TransitDirectionsSnapshot {
  const state = useDirectionsStore.getState();
  return {
    enabled: true,
    timeMode: "now",
    waypoints: state.waypoints,
    transitDepartureTime: state.transitDepartureTime,
    transitArrivalTime: state.transitArrivalTime,
    transitPreferredModes: state.transitPreferredModes,
    transitRoutePreference: state.transitRoutePreference,
    transitAccessMode: state.transitAccessMode,
    wheelchairRequired: state.wheelchairRequired,
    maxTransfers: state.maxTransfers,
    transferBuffer: state.transferBuffer,
    requireBikeTransport: state.requireBikeTransport,
    bikeHillPreference: state.bikeHillPreference,
    deutschlandticketOnly: state.deutschlandticketOnly,
    ...overrides,
  };
}
function lastPlan(): Parameters<typeof realUseTransitPlan>[0] {
  return mocks.plan.mock.calls.at(-1)?.[0] as Parameters<typeof realUseTransitPlan>[0];
}
function itinerary(id: string, overrides: Partial<TripItinerary> = {}): TripItinerary {
  return {
    id,
    source: "synthetic",
    startTime: "2026-10-22T12:00:00Z",
    endTime: "2026-10-22T13:00:00Z",
    duration: 3600,
    transfers: 1,
    walkDistance: 100,
    legs: [],
    ...overrides,
  };
}
function response(items: TripItinerary[], overrides: Partial<TripPlan> = {}): TripPlan {
  return {
    from: { name: "Origin", lat: 52, lng: 13 },
    to: { name: "Destination", lat: 53, lng: 14 },
    provider: "synthetic",
    itineraries: items,
    ...overrides,
  };
}
const a = itinerary("a");
const b = itinerary("b");
beforeEach(() => {
  useDirectionsStore.getState().close();
  useDirectionsStore.getState().setWaypoint(0, [13, 52], "Origin");
  useDirectionsStore.getState().setWaypoint(1, [14, 53], "Destination");
  mocks.plan.mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mocks.chain.mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mocks.germany.mockReset().mockReturnValue({ bothInGermany: false, isResolving: false });
  mocks.capabilities.mockReset().mockReturnValue({ data: undefined });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("transit planning controller", () => {
  it("uses only point-to-point acquisition for an ordinary two-stop trip", () => {
    const view = renderHook(() => useTransitDirectionsPlan(snapshot()));
    expect(view.result.current.isChained).toBe(false);
    expect(mocks.chain.mock.calls.at(-1)?.[0]).toBeNull();
    expect(lastPlan().origin).toEqual([13, 52]);
    expect(lastPlan().destination).toEqual([14, 53]);
    expect(lastPlan().numItineraries).toBe(3);
  });
  it.each(["intermediate", "scheduled"])(
    "uses only chained acquisition for %s waypoints",
    (kind) => {
      if (kind === "intermediate") {
        useDirectionsStore.getState().addWaypoint(0);
        useDirectionsStore.getState().setWaypoint(1, [13.5, 52.5], "Via");
      } else useDirectionsStore.getState().setWaypointSchedule(0, { dwellSeconds: 300 });
      const view = renderHook(() => useTransitDirectionsPlan(snapshot()));
      expect(view.result.current.isChained).toBe(true);
      expect(lastPlan().origin).toBeNull();
      expect(lastPlan().destination).toBeNull();
      const request = mocks.chain.mock.calls.at(-1)?.[0] as {
        waypoints: unknown[];
        schedules: unknown[];
      };
      expect(request.waypoints.length).toBe(kind === "intermediate" ? 3 : 2);
      if (kind === "scheduled") expect(request.schedules).toEqual([{ dwellSeconds: 300 }, null]);
    },
  );
  it("does not issue a chain request for an incomplete via stop or enable a non-transit trip", () => {
    useDirectionsStore.getState().addWaypoint(0);
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot(),
    });
    expect(view.result.current.isChained).toBe(false);
    expect(mocks.chain.mock.calls.at(-1)?.[0]).toBeNull();
    view.rerender(snapshot({ enabled: false }));
    expect(lastPlan().origin).toBeNull();
    expect(lastPlan().destination).toBeNull();
  });
  it("debounces transit times by500ms and preserves ISO depart/arrive semantics", () => {
    vi.useFakeTimers();
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot({ timeMode: "depart" }),
    });
    const departure = new Date("2026-10-22T14:00:00Z");
    view.rerender(snapshot({ timeMode: "depart", transitDepartureTime: departure }));
    act(() => vi.advanceTimersByTime(499));
    expect(lastPlan().departAt).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(lastPlan().departAt).toBe(departure.toISOString());
    const arrival = new Date("2026-10-22T16:00:00Z");
    view.rerender(snapshot({ timeMode: "arrive", transitArrivalTime: arrival }));
    act(() => vi.advanceTimersByTime(500));
    expect(lastPlan().arriveBy).toBe(arrival.toISOString());
    expect(lastPlan().departAt).toBeUndefined();
  });
  it("gates country lookup and D-ticket on the enabled toggle and both German endpoints", () => {
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot(),
    });
    expect(mocks.germany.mock.calls.at(-1)).toEqual([null, null]);
    view.rerender(snapshot({ deutschlandticketOnly: true }));
    expect(mocks.germany.mock.calls.at(-1)).toEqual([
      [13, 52],
      [14, 53],
    ]);
    expect(lastPlan().deutschlandticketOnly).toBe(false);
    mocks.germany.mockReturnValue({ bothInGermany: true });
    view.rerender(snapshot({ deutschlandticketOnly: true }));
    expect(lastPlan().deutschlandticketOnly).toBe(true);
    view.rerender(snapshot({ enabled: false, deutschlandticketOnly: true }));
    expect(mocks.germany.mock.calls.at(-1)).toEqual([null, null]);
    expect(lastPlan().deutschlandticketOnly).toBe(false);
  });
  it("preserves rental metadata and immutable captured navigation options", () => {
    mocks.capabilities.mockReturnValue({
      data: {
        providers: [
          {
            id: "transit-motis-local",
            metadata: {
              source: "source",
              instance: "instance",
              datasetEpoch: "epoch",
              rentalFormFactors: ["bicycle"],
            },
          },
        ],
      },
    });
    const props = snapshot({
      transitAccessMode: "bike_share",
      wheelchairRequired: true,
      maxTransfers: 2,
      transferBuffer: "extra",
      requireBikeTransport: true,
      bikeHillPreference: "avoid",
      transitPreferredModes: ["bus"],
    });
    const view = renderHook((p: TransitDirectionsSnapshot) => useTransitDirectionsPlan(p), {
      initialProps: props,
    });
    expect(lastPlan()).toMatchObject({
      wheelchairRequired: true,
      maxTransfers: 2,
      transferBuffer: "extra",
      requireBikeTransport: true,
      bikeHillPreference: "avoid",
      capabilityEpoch: "epoch",
      rentalSource: "source",
      rentalInstance: "instance",
      rentalFormFactors: ["BICYCLE", "CARGO_BICYCLE"],
      preTransitModes: ["RENTAL"],
      postTransitModes: ["RENTAL"],
      directModes: ["RENTAL"],
    });
    const captured = view.result.current.replanOptions;
    expect(captured.modes).toEqual(["BUS", "COACH"]);
    expect(captured.wheelchairRequired).toBe(true);
    view.rerender({
      ...props,
      wheelchairRequired: false,
      transitAccessMode: "walk",
      transitPreferredModes: ["train"],
    });
    expect(captured.wheelchairRequired).toBe(true);
    expect(captured.modes).toEqual(["BUS", "COACH"]);
    expect(lastPlan().rentalSource).toBeUndefined();
    expect(lastPlan().rentalInstance).toBeUndefined();
    expect(lastPlan().rentalFormFactors).toBeUndefined();
    expect(lastPlan().capabilityEpoch).toBe("epoch");
  });
  it.each(["fewerTransfers", "lessWalking"] as const)(
    "requests5alternatives for %s",
    (preference) => {
      renderHook(() => useTransitDirectionsPlan(snapshot({ transitRoutePreference: preference })));
      expect(lastPlan().numItineraries).toBe(5);
    },
  );
  it("owns next/previous page actions, publication, attribution and endpoint reset", () => {
    const credited = { ...a, contributors: [{ sourceId: "supplier", name: "Synthetic supplier" }] };
    mocks.plan.mockReturnValue({
      data: response([credited], { nextPageToken: "next", previousPageToken: "previous" }),
      isLoading: false,
      isError: false,
    });
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot(),
    });
    expect(view.result.current.itineraries).toEqual([credited]);
    expect(view.result.current.attributions.map((x) => x.sourceId)).toContain("supplier");
    act(() => view.result.current.paging.loadNext());
    expect(lastPlan().pageToken).toBe("next");
    mocks.plan.mockReturnValue({
      data: response([a, b], { previousPageToken: "back" }),
      isLoading: false,
      isError: false,
    });
    view.rerender(snapshot());
    expect(view.result.current.itineraries).toEqual([credited, b]);
    expect(view.result.current.itineraries[0]).toBe(credited);
    act(() => view.result.current.paging.loadPrevious());
    expect(lastPlan().pageToken).toBe("back");
    mocks.plan.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    useDirectionsStore.getState().setWaypoint(1, [15, 54], "New destination");
    view.rerender(snapshot());
    expect(lastPlan().pageToken).toBeUndefined();
    expect(view.result.current.paging.isPage).toBe(false);
  });
  it("publishes the selected rank preference using the existing selection-reset semantics", () => {
    const preferred = itinerary("preferred", { transfers: 0, walkDistance: 50 });
    mocks.plan.mockReturnValue({
      data: response([a, preferred]),
      isLoading: false,
      isError: false,
    });
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot(),
    });
    act(() => useDirectionsStore.getState().setActiveItineraryIndex(1));
    expect(useDirectionsStore.getState().activeItineraryIndex).toBe(1);
    view.rerender(snapshot({ transitRoutePreference: "fewerTransfers" }));
    expect(view.result.current.itineraries).toEqual([preferred, a]);
    expect(useDirectionsStore.getState().activeItineraryIndex).toBe(0);
  });

  it("carries the same resolved policy and epoch into scheduled chain requests", () => {
    useDirectionsStore
      .getState()
      .setWaypointSchedule(1, { arriveBy: "2026-10-22T18:00", timeZone: "Europe/Berlin" });
    mocks.capabilities.mockReturnValue({
      data: {
        providers: [
          {
            id: "transit-motis-local",
            metadata: { datasetEpoch: "epoch", source: "source", instance: "instance" },
          },
        ],
      },
    });
    mocks.germany.mockReturnValue({ bothInGermany: true });
    const view = renderHook(() =>
      useTransitDirectionsPlan(
        snapshot({
          wheelchairRequired: true,
          maxTransfers: 2,
          transferBuffer: "relaxed",
          requireBikeTransport: true,
          bikeHillPreference: "strongly-avoid",
          transitAccessMode: "bike",
          deutschlandticketOnly: true,
        }),
      ),
    );
    expect(view.result.current.isChained).toBe(true);
    expect(mocks.chain.mock.calls.at(-1)?.[0]).toMatchObject({
      wheelchairRequired: true,
      maxTransfers: 2,
      transferBuffer: "relaxed",
      requireBikeTransport: true,
      bikeHillPreference: "strongly-avoid",
      preTransitModes: ["BIKE"],
      postTransitModes: ["BIKE"],
      directModes: ["BIKE"],
      deutschlandticketOnly: true,
      capabilityEpoch: "epoch",
    });
    expect(view.result.current.replanOptions).toMatchObject({
      wheelchairRequired: true,
      maxTransfers: 2,
      deutschlandticketOnly: true,
    });
    expect(lastPlan().origin).toBeNull();
  });

  it("keeps acquisition status/retry results and missing page actions intact", () => {
    const refetch = vi.fn();
    const error = new Error("synthetic");
    const result = { data: undefined, isLoading: false, isError: true, error, refetch };
    mocks.plan.mockReturnValue(result);
    const view = renderHook(() => useTransitDirectionsPlan(snapshot()));
    expect(view.result.current.planQuery).toBe(result);
    act(() => {
      view.result.current.paging.loadNext();
      view.result.current.paging.loadPrevious();
    });
    expect(lastPlan().pageToken).toBeUndefined();
    view.result.current.planQuery.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  it("does not publish a deferred response for an obsolete endpoint through the real query cache", async () => {
    const client = createTestQueryClient();
    const releases: ((value: unknown) => void)[] = [];
    vi.spyOn(apiClient, "get").mockImplementation(
      () => new Promise((resolve) => releases.push(resolve)),
    );
    mocks.plan.mockImplementation((params) =>
      realUseTransitPlan(params as Parameters<typeof realUseTransitPlan>[0]),
    );
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot(),
      wrapper: createQueryWrapper(client),
    });
    try {
      await waitFor(() => expect(releases.length).toBe(1));
      useDirectionsStore.getState().setWaypoint(1, [15, 54], "New destination");
      view.rerender(snapshot());
      await waitFor(() => expect(releases.length).toBe(2));
      await act(async () => releases[1]({ data: response([b]), attributions: [] }));
      await waitFor(() =>
        expect(view.result.current.itineraries.map((item) => item.id)).toEqual(["b"]),
      );
      const published = view.result.current.itineraries;
      await act(async () => releases[0]({ data: response([a]), attributions: [] }));
      expect(view.result.current.itineraries).toBe(published);
    } finally {
      view.unmount();
      client.clear();
    }
  });
});
