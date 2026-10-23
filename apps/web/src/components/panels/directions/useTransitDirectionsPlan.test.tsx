import { apiClient, useDirectionsStore } from "@openmapx/core";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient } from "@/test";
import {
  signTransitPageToken,
  transitRequestFingerprint,
  verifyTransitPageToken,
} from "../../../../../../integrations/transit/page-token";
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

type Change = {
  name: string;
  initial?: Partial<TransitDirectionsSnapshot>;
  arrange?: () => void;
  mutate?: () => void;
  next?: Partial<TransitDirectionsSnapshot>;
};
const epoch = (datasetEpoch: string, source = "source") => ({
  data: {
    providers: [
      { id: "transit-motis-local", metadata: { datasetEpoch, source, instance: "instance" } },
    ],
  },
});
const departure = new Date("2026-10-22T14:00:00Z");
const arrival = new Date("2026-10-22T16:00:00Z");

const routingChanges: Change[] = [
  {
    name: "destination",
    mutate: () => useDirectionsStore.getState().setWaypoint(1, [15, 54], "New destination"),
  },
  {
    name: "origin",
    mutate: () => useDirectionsStore.getState().setWaypoint(0, [12, 51], "New origin"),
  },
  { name: "wheelchairRequired", next: { wheelchairRequired: true } },
  { name: "maxTransfers from unset to zero", next: { maxTransfers: 0 } },
  {
    name: "maxTransfers from two to zero",
    initial: { maxTransfers: 2 },
    next: { maxTransfers: 0 },
  },
  { name: "transferBuffer", next: { transferBuffer: "relaxed" } },
  { name: "requireBikeTransport", next: { requireBikeTransport: true } },
  { name: "bikeHillPreference", next: { bikeHillPreference: "avoid" } },
  { name: "preferred modes", next: { transitPreferredModes: ["bus"] } },
  { name: "access mode", next: { transitAccessMode: "bike" } },
  {
    name: "resolved D-ticket eligibility",
    arrange: () => mocks.germany.mockReturnValue({ bothInGermany: true }),
    initial: { deutschlandticketOnly: false },
    next: { deutschlandticketOnly: true },
  },
  { name: "effective itinerary count", next: { transitRoutePreference: "fewerTransfers" } },
  { name: "time mode", next: { timeMode: "depart" } },
  {
    name: "raw departure time",
    initial: { timeMode: "depart", transitDepartureTime: departure },
    next: { timeMode: "depart", transitDepartureTime: new Date(departure.getTime() + 3_600_000) },
  },
  {
    name: "raw arrival time",
    initial: { timeMode: "arrive", transitArrivalTime: arrival },
    next: { timeMode: "arrive", transitArrivalTime: new Date(arrival.getTime() + 3_600_000) },
  },
  {
    name: "capability epoch",
    arrange: () => mocks.capabilities.mockReturnValue(epoch("epoch-1")),
    mutate: () => mocks.capabilities.mockReturnValue(epoch("epoch-2")),
  },
  {
    name: "rental source",
    initial: { transitAccessMode: "bike_share" },
    arrange: () => mocks.capabilities.mockReturnValue(epoch("epoch-1", "source-1")),
    mutate: () => mocks.capabilities.mockReturnValue(epoch("epoch-1", "source-2")),
  },
  { name: "enabled", next: { enabled: false } },
  {
    name: "chained planning",
    mutate: () => useDirectionsStore.getState().setWaypointSchedule(0, { dwellSeconds: 300 }),
  },
];

function pagedResult(overrides: Partial<TripPlan> = {}) {
  return {
    data: response([a], { nextPageToken: "next", previousPageToken: "previous", ...overrides }),
    isLoading: false,
    isError: false,
  };
}
function pagedView(initial: Partial<TransitDirectionsSnapshot> = {}) {
  mocks.plan.mockReturnValue(pagedResult());
  const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
    initialProps: snapshot(initial),
  });
  return view;
}

describe("transit page ownership", () => {
  it.each(routingChanges)("never pairs a changed $name with the old page token", (change) => {
    change.arrange?.();
    const view = pagedView(change.initial);
    act(() => view.result.current.paging.loadNext());
    expect(lastPlan().pageToken).toBe("next");
    const before = mocks.plan.mock.calls.length;
    change.mutate?.();
    view.rerender(snapshot({ ...change.initial, ...change.next }));
    const after = mocks.plan.mock.calls
      .slice(before)
      .map(([params]) => params as Parameters<typeof realUseTransitPlan>[0]);
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((params) => params.pageToken)).toEqual(after.map(() => undefined));
    expect(view.result.current.paging.isPage).toBe(false);
  });

  it("retires a page the moment the edited date changes and keeps it retired once the debounce settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const initial = { timeMode: "depart", transitDepartureTime: departure } as const;
    const view = pagedView(initial);
    act(() => view.result.current.paging.loadNext());
    const later = new Date(departure.getTime() + 3_600_000);
    const before = mocks.plan.mock.calls.length;
    view.rerender(snapshot({ ...initial, transitDepartureTime: later }));
    expect(lastPlan().pageToken).toBeUndefined();
    expect(lastPlan().departAt).toBe(departure.toISOString());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(lastPlan().departAt).toBe(later.toISOString());
    const after = mocks.plan.mock.calls
      .slice(before)
      .map(([params]) => params as Parameters<typeof realUseTransitPlan>[0]);
    expect(after.map((params) => params.pageToken)).toEqual(after.map(() => undefined));
  });

  it("keeps compatible paging for equivalent coordinate values, list order and client-only ranking", () => {
    const view = pagedView({
      transitPreferredModes: ["bus", "tram"],
      transitRoutePreference: "fewerTransfers",
    });
    act(() => view.result.current.paging.loadNext());
    view.rerender(
      snapshot({
        waypoints: useDirectionsStore.getState().waypoints.map((waypoint) => ({
          ...waypoint,
          coords: [...(waypoint.coords ?? [])],
        })) as never,
        transitPreferredModes: ["tram", "bus"],
        transitRoutePreference: "lessWalking",
      }),
    );
    expect(lastPlan().pageToken).toBe("next");
    expect(view.result.current.paging.isPage).toBe(true);
  });

  it("makes page callbacks captured before a routing change inert", () => {
    const view = pagedView();
    const before = view.result.current.paging;
    useDirectionsStore.getState().setWaypoint(1, [15, 54], "New destination");
    view.rerender(snapshot());
    act(() => {
      before.loadNext();
      before.loadPrevious();
    });
    expect(lastPlan().pageToken).toBeUndefined();
    expect(view.result.current.paging.isPage).toBe(false);
  });

  it("never restores an earlier page when the routing query returns to a previous value", () => {
    const view = pagedView();
    const original = view.result.current.paging;
    act(() => view.result.current.paging.loadNext());
    expect(lastPlan().pageToken).toBe("next");
    useDirectionsStore.getState().setWaypoint(1, [15, 54], "B");
    view.rerender(snapshot());
    useDirectionsStore.getState().setWaypoint(1, [14, 53], "Destination");
    view.rerender(snapshot());
    expect(lastPlan().pageToken).toBeUndefined();
    act(() => original.loadNext());
    expect(lastPlan().pageToken).toBeUndefined();
    act(() => view.result.current.paging.loadPrevious());
    expect(lastPlan().pageToken).toBe("previous");
  });

  it("lets only one page action act per rendered ownership", () => {
    const view = pagedView();
    const paging = view.result.current.paging;
    act(() => {
      paging.loadNext();
      paging.loadPrevious();
    });
    expect(lastPlan().pageToken).toBe("next");
  });

  it("cannot resurrect paging while planning is disabled or chained", () => {
    const view = pagedView({ enabled: false });
    act(() => view.result.current.paging.loadNext());
    expect(lastPlan().pageToken).toBeUndefined();
    useDirectionsStore.getState().setWaypointSchedule(0, { dwellSeconds: 300 });
    view.rerender(snapshot());
    act(() => view.result.current.paging.loadPrevious());
    expect(lastPlan().pageToken).toBeUndefined();
    expect(view.result.current.paging.isPage).toBe(false);
  });
});

describe("transit paging through the real query cache and signed tokens", () => {
  const SECRET = "synthetic-signing-secret-for-controller-tests-only";
  const pages: Record<string, { items: TripItinerary[]; previous?: string; next?: string }> = {
    initial: { items: [b], previous: "p0", next: "n0" },
    n0: { items: [itinerary("c")], previous: "p1", next: "n1" },
    p1: { items: [a], previous: "p2", next: "n2" },
  };
  type Request = {
    params: Record<string, string>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  let requests: Request[];
  let client: ReturnType<typeof createTestQueryClient>;

  /** Server side of the transport: the real signer/verifier over the real serializer output. */
  function serve(params: Record<string, string>) {
    const fingerprint = transitRequestFingerprint(params);
    const key = params.page_token
      ? verifyTransitPageToken(params.page_token, SECRET, fingerprint).cursor
      : "initial";
    const sign = (cursor: string, direction: "previous" | "next") =>
      signTransitPageToken(
        {
          cursor,
          source: "synthetic",
          instance: "synthetic",
          datasetEpoch: "epoch",
          fingerprint,
          direction,
        },
        SECRET,
      );
    const page = params.wheelchair ? { items: [itinerary("z")] } : (pages[key] ?? { items: [] });
    return {
      data: response(page.items, {
        ...("previous" in page && page.previous
          ? { previousPageToken: sign(page.previous, "previous") }
          : {}),
        ...("next" in page && page.next ? { nextPageToken: sign(page.next, "next") } : {}),
      }),
      attributions: [],
    };
  }
  async function release(index: number) {
    await act(async () => {
      try {
        requests[index].resolve(serve(requests[index].params));
      } catch (error) {
        requests[index].reject(error);
      }
    });
  }
  const ids = (view: { result: { current: { itineraries: TripItinerary[] } } }) =>
    view.result.current.itineraries.map((item) => item.id);

  beforeEach(() => {
    requests = [];
    client = createTestQueryClient();
    vi.spyOn(apiClient, "get").mockImplementation(
      (_url: unknown, params: unknown) =>
        new Promise((resolve, reject) =>
          requests.push({ params: params as Record<string, string>, resolve, reject }),
        ),
    );
    mocks.plan.mockImplementation((params) =>
      realUseTransitPlan(params as Parameters<typeof realUseTransitPlan>[0]),
    );
  });
  afterEach(() => client.clear());

  it("verifies each earlier/later token on the original wire time across minute rollover and merges pages", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime("2026-10-23T05:20:10Z");
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot(),
      wrapper: createQueryWrapper(client),
    });
    try {
      await waitFor(() => expect(requests.length).toBe(1));
      await release(0);
      await waitFor(() => expect(ids(view)).toEqual(["b"]));

      vi.setSystemTime("2026-10-23T05:21:30Z");
      act(() => view.result.current.paging.loadNext());
      await waitFor(() => expect(requests.length).toBe(2));
      await release(1);
      await waitFor(() => expect(ids(view)).toEqual(["b", "c"]));

      vi.setSystemTime("2026-10-23T05:22:30Z");
      act(() => view.result.current.paging.loadPrevious());
      await waitFor(() => expect(requests.length).toBe(3));
      await release(2);
      await waitFor(() => expect(ids(view)).toEqual(["a", "b", "c"]));

      expect(requests.map((request) => request.params.time)).toEqual(
        Array(3).fill("2026-10-23T05:20:00Z"),
      );
      expect(requests.map((request) => request.params.page_token !== undefined)).toEqual([
        false,
        true,
        true,
      ]);
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it("never merges an obsolete deferred page into a replacement query's results", async () => {
    const view = renderHook((props: TransitDirectionsSnapshot) => useTransitDirectionsPlan(props), {
      initialProps: snapshot(),
      wrapper: createQueryWrapper(client),
    });
    try {
      await waitFor(() => expect(requests.length).toBe(1));
      await release(0);
      await waitFor(() => expect(ids(view)).toEqual(["b"]));
      act(() => view.result.current.paging.loadNext());
      await waitFor(() => expect(requests.length).toBe(2));

      view.rerender(snapshot({ wheelchairRequired: true }));
      await waitFor(() => expect(requests.length).toBe(3));
      expect(requests[2].params.page_token).toBeUndefined();
      expect(requests[2].params.wheelchair).toBe("true");
      await release(2);
      await waitFor(() => expect(ids(view)).toEqual(["z"]));
      const published = view.result.current.itineraries;

      await release(1);
      expect(view.result.current.itineraries).toBe(published);
      expect(ids(view)).toEqual(["z"]);
      expect(
        requests.filter((request) => request.params.wheelchair && request.params.page_token),
      ).toEqual([]);
    } finally {
      view.unmount();
      client.clear();
    }
  });
});
