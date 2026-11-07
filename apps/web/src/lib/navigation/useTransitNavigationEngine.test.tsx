import { apiClient, type FixInput, useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

let handler: ((fix: FixInput) => void) | null = null;
vi.mock("../useWatchPosition", () => ({
  useWatchPosition: (_active: boolean, onFix: (fix: FixInput) => void) => {
    handler = onFix;
  },
}));
const map = vi.hoisted(() => ({ easeTo: vi.fn(), getZoom: () => 15 }));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMapOptional: () => ({ mapRef: { current: map } }),
}));

import { createQueryWrapper, createTestQueryClient, renderHookWithQuery } from "@/test/query";
import { useNavigationConnectivity } from "./navigationConnectivity";
import { useTransitLiveRefresh } from "./useTransitLiveRefresh";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/mobile/useMobileRuntime", () => ({
  useMobileRuntime: () => ({ browserAuthority: true }),
}));

import { TransitJourneyControls } from "@/components/navigation/TransitJourneyControls";
import { useTransitNavigationEngine } from "./useTransitNavigationEngine";

const trip = () =>
  ({
    duration: 600,
    startTime: "",
    endTime: "",
    transfers: 0,
    walkDistance: 0,
    legs: [
      {
        mode: "bus",
        tripId: "bus",
        route: { shortName: "12" },
        startTime: "2020-01-01T00:00:00Z",
        endTime: "2020-01-01T00:10:00Z",
        from: { name: "A", lat: 0, lng: 0 },
        to: { name: "B", lat: 0, lng: 0.02 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.02, 0],
          ],
        },
      },
    ],
  }) as TripItinerary;
afterEach(() => {
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().setConnectivity("online");
  vi.restoreAllMocks();
  map.easeTo.mockClear();
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

it("recovers after one success when a pre-outage in-flight request fails", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  useNavigationStore.getState().startTransitNavigation(selectedTrip());
  const view = renderHookWithQuery(() => useTransitNavigationEngine());
  await waitFor(() =>
    expect(useNavigationStore.getState().transitCaptures[0]?.status).toBe("captured"),
  );
  let reject!: (reason: Error) => void;
  get.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = view.queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
  });
  await waitFor(() => expect(reject).toBeTypeOf("function"));
  act(() => useNavigationStore.getState().setConnectivity("offline"));
  act(() => useNavigationStore.getState().setConnectivity("online"));
  get.mockRejectedValue(new Error("unavailable"));
  await act(async () => {
    reject(new Error("unavailable"));
    await pending;
  });
  get.mockResolvedValue(liveJourney());
  await act(async () => {
    await view.queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
  });
  await waitFor(() => expect(useNavigationStore.getState().liveDataUnavailable).toBe(false));
});

it("clears the warning immediately when the rider reaches the final walking leg", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  const chosen = selectedTrip();
  chosen.legs.push({ ...chosen.legs[0], mode: "walking", tripId: undefined, route: undefined });
  useNavigationStore.getState().startTransitNavigation(chosen);
  renderHookWithQuery(() => useTransitNavigationEngine());
  await waitFor(() =>
    expect(useNavigationStore.getState().transitCaptures[0]?.status).toBe("captured"),
  );
  act(() => useNavigationStore.getState().setLiveDataUnavailable(true));
  const progress = useNavigationStore.getState().transitProgress;
  if (!progress) throw new Error("Expected initialized transit progress");
  act(() =>
    useNavigationStore.setState({
      transitProgress: {
        ...progress,
        currentLegIndex: 1,
        phase: "walking",
      },
    }),
  );
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
});

it("continues platform polling after the selected vehicle data recovers", async () => {
  vi.useFakeTimers();
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  useNavigationStore.getState().startTransitNavigation(selectedTrip());
  renderHookWithQuery(() => useTransitNavigationEngine());
  await act(async () => vi.advanceTimersByTimeAsync(1));
  act(() => useNavigationStore.getState().setLiveDataUnavailable(true));
  await act(async () => vi.advanceTimersByTimeAsync(30001));
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
  const requests = get.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90000));
  expect(get.mock.calls.length).toBeGreaterThan(requests);
});

it("recovers vehicle updates after a real refresh mutation fails while retaining a last-known departure", async () => {
  vi.useFakeTimers();
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  const { ApiClientError } = await import("@openmapx/core/navigation/api");
  const post = vi.spyOn(apiClient, "post").mockRejectedValue(new ApiClientError(400, null, null));
  const chosen = selectedTrip();
  chosen.refreshToken = "expired";
  chosen.legs[0].realtime = true;
  chosen.legs[0].startTime = new Date(Date.now() + 300000).toISOString();
  useNavigationStore.getState().startTransitNavigation(chosen);
  function Runtime() {
    useTransitNavigationEngine();
    useTransitLiveRefresh(true);
    return <TransitJourneyControls onAlternatives={() => {}} />;
  }
  render(<Runtime />, { wrapper: createQueryWrapper() });
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(screen.queryByText("navigation.transitLiveUpdatesUnavailable")).toBeNull();
  get.mockRejectedValue(new Error("vehicle source unavailable"));
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(true);
  expect(screen.getByText("navigation.transitLiveUpdatesUnavailable")).toBeTruthy();
  get.mockResolvedValue(liveJourney());
  await act(async () => vi.advanceTimersByTimeAsync(30010));
  expect(screen.queryByText("navigation.transitLiveUpdatesUnavailable")).toBeNull();
  expect(screen.getByText("navigation.departureLastKnown")).toBeTruthy();
  expect(useNavigationStore.getState().itinerary).toBe(chosen);
  await act(async () => vi.advanceTimersByTimeAsync(90000));
  expect(post).toHaveBeenCalledTimes(1);
});

it("recovers the rendered warning through browser events without a UI polling owner", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  let online = true;
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
  useNavigationStore.getState().startTransitNavigation(selectedTrip());
  const queryClient = createTestQueryClient();
  function Runtime() {
    useNavigationConnectivity();
    useTransitNavigationEngine();
    return <TransitJourneyControls onAlternatives={() => {}} />;
  }
  render(<Runtime />, { wrapper: createQueryWrapper(queryClient) });
  await waitFor(() =>
    expect(useNavigationStore.getState().transitCaptures[0]?.status).toBe("captured"),
  );
  act(() => {
    online = false;
    window.dispatchEvent(new Event("offline"));
  });
  expect(screen.getByText("navigation.transitLiveUpdatesUnavailable")).toBeTruthy();
  act(() => {
    online = true;
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() =>
    expect(screen.queryByText("navigation.transitLiveUpdatesUnavailable")).toBeNull(),
  );
});

const liveJourney = () => ({
  data: {
    stops: [
      { stopId: "A", name: "A", lat: 0, lng: 0 },
      { stopId: "B", name: "B", lat: 0, lng: 0.02 },
    ],
  },
  attributions: [],
  freshness: {
    fetchedAt: new Date().toISOString(),
    hasRealtimeData: true,
    isStale: false,
    isPartial: false,
  },
});
const selectedTrip = () => {
  const chosen = trip();
  chosen.legs[0].from.stopId = "A";
  chosen.legs[0].to.stopId = "B";
  return chosen;
};

it.each(["partial", "stale", "null", "unmappable", "error"])(
  "blocks recovery on %s data then recovers on a complete response",
  async (kind) => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
    useNavigationStore.getState().startTransitNavigation(selectedTrip());
    const { queryClient } = renderHookWithQuery(() => useTransitNavigationEngine());
    await waitFor(() =>
      expect(useNavigationStore.getState().transitCaptures[0]?.status).toBe("captured"),
    );
    act(() =>
      useNavigationStore
        .getState()
        .markTransitRefreshUnavailable(useNavigationStore.getState().transitRequestId),
    );
    const bad = liveJourney();
    if (kind === "partial") bad.freshness.isPartial = true;
    if (kind === "stale") bad.freshness.isStale = true;
    if (kind === "unmappable") bad.data.stops = [];
    if (kind === "error") get.mockRejectedValue(new Error("unavailable"));
    else get.mockResolvedValue(kind === "null" ? { ...bad, data: null } : bad);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
    });
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
    get.mockResolvedValue(liveJourney());
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
    });
    await waitFor(() => expect(useNavigationStore.getState().liveDataUnavailable).toBe(false));
    expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(true);
  },
);

it("requires a fresh response for every tracked trip, even with identical timestamps and content", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  const chosen = selectedTrip();
  chosen.legs.push({ ...chosen.legs[0], tripId: "second" });
  useNavigationStore.getState().startTransitNavigation(chosen);
  const { queryClient } = renderHookWithQuery(() => useTransitNavigationEngine());
  await waitFor(() => expect(useNavigationStore.getState().transitCaptures).toHaveLength(2));
  const originalTime = Date.now();
  act(() => useNavigationStore.getState().setConnectivity("offline"));
  act(() => useNavigationStore.getState().setConnectivity("online"));
  act(() =>
    queryClient.setQueryData(["vehicle-journey", "bus", undefined], liveJourney(), {
      updatedAt: originalTime,
    }),
  );
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  act(() =>
    queryClient.setQueryData(["vehicle-journey", "second", undefined], liveJourney(), {
      updatedAt: originalTime,
    }),
  );
  await waitFor(() => expect(useNavigationStore.getState().liveDataUnavailable).toBe(false));
});

it("does not count cached or offline completions as recovery across remount", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  useNavigationStore.getState().startTransitNavigation(selectedTrip());
  const view = renderHookWithQuery(() => useTransitNavigationEngine());
  await waitFor(() =>
    expect(useNavigationStore.getState().transitCaptures[0]?.status).toBe("captured"),
  );
  act(() => useNavigationStore.getState().setConnectivity("offline"));
  await act(async () => {
    await view.queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
  });
  view.unmount();
  const next = renderHookWithQuery(() => useTransitNavigationEngine(), {
    queryClient: view.queryClient,
  });
  act(() => useNavigationStore.getState().setConnectivity("online"));
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  await act(async () => {
    await next.queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
  });
  await waitFor(() => expect(useNavigationStore.getState().liveDataUnavailable).toBe(false));
});

it("does not use a previous session's in-flight result to recover a replacement with the same trip IDs", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(liveJourney());
  useNavigationStore.getState().startTransitNavigation(selectedTrip());
  const view = renderHookWithQuery(() => useTransitNavigationEngine());
  await waitFor(() =>
    expect(useNavigationStore.getState().transitCaptures[0]?.status).toBe("captured"),
  );
  let resolve!: (value: ReturnType<typeof liveJourney>) => void;
  get.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = view.queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
  });
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  act(() => useNavigationStore.getState().replaceItinerary(selectedTrip()));
  act(() => useNavigationStore.getState().setLiveDataUnavailable(true));
  await act(async () => {
    resolve(liveJourney());
    await pending;
  });
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  get.mockResolvedValue(liveJourney());
  await act(async () => {
    await view.queryClient.refetchQueries({ queryKey: ["vehicle-journey"] });
  });
  await waitFor(() => expect(useNavigationStore.getState().liveDataUnavailable).toBe(false));
});

it("does not introduce a warning on a healthy remount and reconnects without live trip IDs", async () => {
  const chosen = selectedTrip();
  delete chosen.legs[0].tripId;
  useNavigationStore.getState().startTransitNavigation(chosen);
  const view = renderHookWithQuery(() => useTransitNavigationEngine());
  view.unmount();
  renderHookWithQuery(() => useTransitNavigationEngine());
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
  act(() => useNavigationStore.getState().setConnectivity("offline"));
  act(() => useNavigationStore.getState().setConnectivity("online"));
  await waitFor(() => expect(useNavigationStore.getState().liveDataUnavailable).toBe(false));
});
it("does not plan or replace a connection after its departure time or a shape deviation", () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: { stops: [] } });
  const chosen = trip();
  useNavigationStore.getState().startTransitNavigation(chosen);
  renderHookWithQuery(() => useTransitNavigationEngine());
  act(() => handler?.({ coords: [0.01, 0.01], accuracy: 5, timestampMs: Date.now() }));
  expect(useNavigationStore.getState().itinerary).toBe(chosen);
  expect(useNavigationStore.getState().transitProgress?.phase).toBe("waiting-to-board");
  expect(get.mock.calls.every(([path]) => !String(path).includes("/plan"))).toBe(true);
});
it("follows raw accepted position and ignores rejected positions", () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { stops: [] } });
  useNavigationStore.getState().startTransitNavigation(trip());
  renderHookWithQuery(() => useTransitNavigationEngine());
  const now = Date.now();
  act(() => handler?.({ coords: [0.01, 0.01], accuracy: 5, timestampMs: now }));
  expect(useNavigationStore.getState().transitProgress?.position).toEqual([0.01, 0.01]);
  act(() => handler?.({ coords: [0.02, 0.02], accuracy: 200, timestampMs: now + 1 }));
  expect(map.easeTo).toHaveBeenCalledTimes(0);
  expect(useNavigationStore.getState().transitProgress?.position).toEqual([0.01, 0.01]);
});
it("retains confirmed boarding on component remount and same-journey live refresh", () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { stops: [] } });
  useNavigationStore.getState().startTransitNavigation(trip());
  const view = renderHookWithQuery(() => useTransitNavigationEngine());
  act(() => {
    expect(useNavigationStore.getState().applyTransitAction({ type: "board", legIndex: 0 })).toBe(
      true,
    );
  });
  view.unmount();
  act(() => useNavigationStore.getState().updateItinerary({ ...trip(), refreshToken: "rotated" }));
  renderHookWithQuery(() => useTransitNavigationEngine());
  expect(useNavigationStore.getState().transitProgress?.phase).toBe("riding");
});

it("recovers the offline warning after the selected vehicle's data returns", async () => {
  const chosen = trip();
  chosen.legs[0].from.stopId = "A";
  chosen.legs[0].to.stopId = "B";
  const response = (platform: string) => ({
    data: {
      stops: [
        { stopId: "A", name: "A", lat: 0, lng: 0, platform },
        { stopId: "B", name: "B", lat: 0, lng: 0.02 },
      ],
    },
    attributions: [],
    freshness: { fetchedAt: new Date().toISOString(), hasRealtimeData: true, isStale: false },
  });
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(response("1"));
  useNavigationStore.getState().startTransitNavigation(chosen);
  const { queryClient } = renderHookWithQuery(() => useTransitNavigationEngine());
  await waitFor(() =>
    expect(useNavigationStore.getState().transitCaptures[0]?.status).toBe("captured"),
  );
  act(() => useNavigationStore.getState().applyTransitAction({ type: "board", legIndex: 0 }));
  act(() => useNavigationStore.getState().setConnectivity("offline"));
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  act(() => useNavigationStore.getState().setConnectivity("online"));
  get.mockResolvedValue(response("2"));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["vehicle-journey"] });
  });
  await waitFor(() =>
    expect(useNavigationStore.getState().transitCaptures[0]?.stops[0]?.platform).toBe("2"),
  );
  expect(useNavigationStore.getState().itinerary).toBe(chosen);
  expect(useNavigationStore.getState().transitProgress?.phase).toBe("riding");
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
});

it("refreshes upcoming captured journeys after platform evidence becomes available", async () => {
  vi.useFakeTimers();
  let enriched = false;
  vi.spyOn(apiClient, "get").mockImplementation(async (path) => {
    const future = String(path).endsWith("/future");
    return {
      data: {
        stops: [
          {
            stopId: future ? "fa" : "a",
            name: "Board",
            lat: 0,
            lng: 0,
            ...(future && enriched
              ? { departurePlatform: { code: "3", kind: "correction", sourceId: "siri" } }
              : {}),
          },
          { stopId: future ? "fb" : "b", name: "Alight", lat: 0, lng: 0.02 },
        ],
      },
    };
  });
  const chosen = trip();
  chosen.legs[0].from.stopId = "a";
  chosen.legs[0].to.stopId = "b";
  chosen.legs.push({
    ...chosen.legs[0],
    tripId: "future",
    from: { ...chosen.legs[0].from, stopId: "fa" },
    to: { ...chosen.legs[0].to, stopId: "fb" },
  });
  useNavigationStore.getState().startTransitNavigation(chosen);
  const view = renderHookWithQuery(() => useTransitNavigationEngine());
  try {
    await act(async () => vi.advanceTimersByTimeAsync(1));
    enriched = true;
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(
      useNavigationStore.getState().transitCaptures.find((c) => c.tripId === "future")?.stops[0]
        .departurePlatform?.code,
    ).toBe("3");
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
