import { useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { onlineManager } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useRefreshTransitItinerary: () => ({ mutateAsync: api.refresh }),
}));

import { useTransitLiveRefresh } from "./useTransitLiveRefresh";

const trip = (token: string): TripItinerary => ({
  refreshToken: token,
  legs: [],
  duration: 0,
  startTime: "",
  endTime: "",
  transfers: 0,
  walkDistance: 0,
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  api.refresh.mockReset();
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().setConnectivity("online");
  onlineManager.setOnline(true);
});
describe("transit live refresh ownership", () => {
  it.each(["new trip", "replacement", "unmount"])(
    "ignores an old refresh after %s",
    async (change) => {
      vi.useFakeTimers();
      let resolve: (value: unknown) => void = () => {};
      api.refresh.mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      useNavigationStore.getState().startTransitNavigation(trip("old"));
      const view = renderHook(() => useTransitLiveRefresh(true));
      act(() => vi.advanceTimersByTime(30_000));
      expect(api.refresh).toHaveBeenCalledWith("old");
      act(() => {
        if (change === "unmount") view.unmount();
        else if (change === "replacement")
          useNavigationStore.getState().replaceItinerary(trip("replacement"));
        else {
          useNavigationStore.getState().stopNavigation();
          useNavigationStore.getState().startTransitNavigation(trip("new"));
        }
      });
      const before = useNavigationStore.getState().itinerary;
      await act(async () => resolve({ data: { itinerary: trip("obsolete") } }));
      expect(useNavigationStore.getState().itinerary).toBe(before);
    },
  );
  it("rotates the token on the current trip and refreshes again", async () => {
    vi.useFakeTimers();
    let n = 0;
    api.refresh.mockImplementation(async () => ({ data: { itinerary: trip(`token-${++n}`) } }));
    useNavigationStore.getState().startTransitNavigation(trip("initial"));
    renderHook(() => useTransitLiveRefresh(true));
    await act(async () => vi.advanceTimersByTime(30_000));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(api.refresh.mock.calls.map((c) => c[0])).toEqual(["initial", "token-1"]);
    expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("token-2");
  });
});

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("transit polling lifecycle", () => {
  it.each(["inactive", "no token", "non-transit", "not navigating"])(
    "does not poll when %s",
    (reason) => {
      vi.useFakeTimers();
      useNavigationStore
        .getState()
        .startTransitNavigation(trip(reason === "no token" ? "" : "initial"));
      if (reason === "non-transit") useNavigationStore.setState({ kind: "ground" });
      if (reason === "not navigating") useNavigationStore.getState().stopNavigation();
      renderHook(() => useTransitLiveRefresh(reason !== "inactive"));
      act(() => vi.advanceTimersByTime(90_000));
      expect(api.refresh).not.toHaveBeenCalled();
    },
  );
  it.each(["rejection", "missing data"])(
    "retains the itinerary after %s and recovers using the same replayable token",
    async (outcome) => {
      vi.useFakeTimers();
      const flight = deferred();
      api.refresh.mockImplementation(() => flight.promise);
      useNavigationStore.getState().startTransitNavigation(trip("initial"));
      const initial = useNavigationStore.getState().itinerary;
      renderHook(() => useTransitLiveRefresh(true));
      act(() => vi.advanceTimersByTime(90_000));
      expect(api.refresh).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === "rejection") flight.reject(new Error("offline"));
        else flight.resolve({});
      });
      expect(useNavigationStore.getState().itinerary).toBe(initial);
      api.refresh.mockResolvedValue({
        data: { itinerary: trip("recovered") },
        freshness: { hasRealtimeData: true, isStale: false, isPartial: false },
      });
      await act(async () => vi.advanceTimersByTime(30_000));
      expect(api.refresh.mock.calls.map((call) => call[0])).toEqual(["initial", "initial"]);
      expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
    },
  );
  it("replays the token after interrupted ownership", async () => {
    vi.useFakeTimers();
    const flight = deferred();
    api.refresh.mockImplementation(() => flight.promise);
    useNavigationStore.getState().startTransitNavigation(trip("initial"));
    const initial = useNavigationStore.getState().itinerary;
    const view = renderHook(({ active }) => useTransitLiveRefresh(active), {
      initialProps: { active: true },
    });
    act(() => vi.advanceTimersByTime(30_000));
    view.rerender({ active: false });
    await act(async () => flight.resolve({ data: { itinerary: trip("obsolete") } }));
    act(() => vi.advanceTimersByTime(90_000));
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().itinerary).toBe(initial);
    api.refresh.mockResolvedValue({
      data: { itinerary: trip("fresh") },
      freshness: { hasRealtimeData: true, isStale: false, isPartial: false },
    });
    view.rerender({ active: true });
    act(() => vi.advanceTimersByTime(29_999));
    expect(api.refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("fresh");
    expect(api.refresh).toHaveBeenCalledTimes(2);
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
  });
  it("old flight settlement cannot clear a new trip's pending flight", async () => {
    vi.useFakeTimers();
    const old = deferred();
    const current = deferred();
    let requests = 0;
    api.refresh.mockImplementation(() => (++requests === 1 ? old.promise : current.promise));
    useNavigationStore.getState().startTransitNavigation(trip("old"));
    renderHook(() => useTransitLiveRefresh(true));
    act(() => vi.advanceTimersByTime(30_000));
    act(() => {
      useNavigationStore.getState().stopNavigation();
      useNavigationStore.getState().startTransitNavigation(trip("new"));
    });
    const before = useNavigationStore.getState().itinerary;
    act(() => vi.advanceTimersByTime(30_000));
    await act(async () => old.resolve({ data: { itinerary: trip("obsolete") } }));
    expect(useNavigationStore.getState().itinerary).toBe(before);
    act(() => vi.advanceTimersByTime(90_000));
    expect(api.refresh.mock.calls.map((call) => call[0])).toEqual(["old", "new"]);
    await act(async () => current.resolve({ data: { itinerary: trip("latest") } }));
    expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("latest");
  });
});

it("starts a new token chain only after explicit journey replacement", async () => {
  vi.useFakeTimers();
  useNavigationStore.getState().startTransitNavigation(trip("broken"));
  useNavigationStore
    .getState()
    .markTransitRefreshUnavailable(useNavigationStore.getState().transitRequestId);
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(true);
  api.refresh.mockResolvedValue({ data: { itinerary: trip("rotated") } });
  renderHook(() => useTransitLiveRefresh(true));
  await act(async () => vi.advanceTimersByTime(90000));
  expect(api.refresh).not.toHaveBeenCalled();
  act(() => useNavigationStore.getState().replaceItinerary(trip("new")));
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
  await act(async () => vi.advanceTimersByTime(30000));
  expect(api.refresh).toHaveBeenCalledWith("new");
  expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("rotated");
});

it.each(["failure", "missing successor"])(
  "ignores an obsolete %s after journey replacement",
  async (outcome) => {
    vi.useFakeTimers();
    const flight = deferred();
    api.refresh.mockReturnValue(flight.promise);
    useNavigationStore.getState().startTransitNavigation(trip("old"));
    renderHook(() => useTransitLiveRefresh(true));
    act(() => vi.advanceTimersByTime(30000));
    act(() => useNavigationStore.getState().replaceItinerary(trip("new")));
    await act(async () => {
      if (outcome === "failure") flight.reject(new Error("offline"));
      else flight.resolve({ data: { itinerary: trip("") } });
    });
    expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("new");
    expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
  },
);

it.each(["store", "query manager"])(
  "does not spend an untouched token while %s is offline",
  async (source) => {
    vi.useFakeTimers();
    if (source === "store") useNavigationStore.getState().setConnectivity("offline");
    else onlineManager.setOnline(false);
    useNavigationStore.getState().startTransitNavigation(trip("unused"));
    api.refresh.mockResolvedValue({ data: { itinerary: trip("next") } });
    renderHook(() => useTransitLiveRefresh(true));
    await act(async () => vi.advanceTimersByTime(30000));
    expect(api.refresh).not.toHaveBeenCalled();
    act(() => {
      useNavigationStore.getState().setConnectivity("online");
      onlineManager.setOnline(true);
    });
    await act(async () => vi.advanceTimersByTime(30000));
    expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("next");
  },
);

it("keeps a failed token disabled after vehicle recovery, reconnect and remount", async () => {
  vi.useFakeTimers();
  useNavigationStore.getState().startTransitNavigation(trip("spent"));
  const { ApiClientError } = await import("@openmapx/core/navigation/api");
  api.refresh.mockRejectedValue(new ApiClientError(409, null, null));
  const view = renderHook(() => useTransitLiveRefresh(true));
  await act(async () => vi.advanceTimersByTime(30000));
  await act(async () => vi.advanceTimersByTime(90000));
  expect(api.refresh).toHaveBeenCalledTimes(1);
  act(() => {
    useNavigationStore.getState().setConnectivity("offline");
    useNavigationStore.getState().setConnectivity("online");
    useNavigationStore.getState().setLiveDataUnavailable(false);
  });
  view.unmount();
  renderHook(() => useTransitLiveRefresh(true));
  await act(async () => vi.advanceTimersByTime(90000));
  expect(api.refresh).toHaveBeenCalledTimes(1);
});

it("breaks the chain when a consumed response cannot be applied during rerouting", async () => {
  vi.useFakeTimers();
  const flight = deferred();
  api.refresh.mockReturnValue(flight.promise);
  useNavigationStore.getState().startTransitNavigation(trip("initial"));
  const initial = useNavigationStore.getState().itinerary;
  renderHook(() => useTransitLiveRefresh(true));
  act(() => vi.advanceTimersByTime(30000));
  act(() => useNavigationStore.getState().setTransitRerouteNeeded(true));
  await act(async () => flight.resolve({ data: { itinerary: trip("successor") } }));
  expect(useNavigationStore.getState().itinerary).toBe(initial);
  act(() => vi.advanceTimersByTime(90000));
  expect(api.refresh).toHaveBeenCalledTimes(1);
  act(() => useNavigationStore.getState().setTransitRerouteNeeded(false));
  await act(async () => vi.advanceTimersByTime(30000));
  expect(api.refresh).toHaveBeenCalledTimes(1);
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(true);
});

it("never applies a fallback train during navigation", async () => {
  vi.useFakeTimers();
  api.refresh.mockResolvedValue({
    data: { itinerary: trip("different-train"), fallbackOccurred: true },
  });
  useNavigationStore.getState().startTransitNavigation(trip("selected"));
  renderHook(() => useTransitLiveRefresh(true));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("selected");
  expect(useNavigationStore.getState().transitRerouteNeeded).toBe(true);
});

it("keeps live data unavailable when a successful refresh has no successor", async () => {
  vi.useFakeTimers();
  api.refresh.mockResolvedValue({
    data: { itinerary: { ...trip("unused"), refreshToken: undefined } },
  });
  useNavigationStore.getState().startTransitNavigation(trip("initial"));
  renderHook(() => useTransitLiveRefresh(true));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  expect(useNavigationStore.getState().itinerary?.refreshToken).toBeUndefined();
});

it.each([
  { freshness: undefined, recovers: false },
  { freshness: { hasRealtimeData: false, isStale: false }, recovers: false },
  { freshness: { hasRealtimeData: true, isStale: true }, recovers: false },
  { freshness: { hasRealtimeData: true, isStale: false, isPartial: true }, recovers: false },
  { freshness: { hasRealtimeData: true, isStale: false, isPartial: false }, recovers: true },
])(
  "only fresh complete realtime clears the warning: $freshness",
  async ({ freshness, recovers }) => {
    vi.useFakeTimers();
    useNavigationStore.getState().startTransitNavigation(trip("initial"));
    useNavigationStore.getState().setLiveDataUnavailable(true);
    api.refresh.mockResolvedValue({ data: { itinerary: trip("successor") }, freshness });
    renderHook(() => useTransitLiveRefresh(true));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("successor");
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(!recovers);
    expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
  },
);
