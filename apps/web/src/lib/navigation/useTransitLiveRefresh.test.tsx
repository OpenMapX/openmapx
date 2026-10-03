import { useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
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
    "retains the itinerary after %s and polls again",
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
      api.refresh.mockResolvedValue({ data: { itinerary: trip("recovered") } });
      await act(async () => vi.advanceTimersByTime(30_000));
      expect(api.refresh.mock.calls.map((call) => call[0])).toEqual(["initial", "initial"]);
      expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("recovered");
    },
  );
  it("suppresses ticks and response application while rerouting", async () => {
    vi.useFakeTimers();
    const flight = deferred();
    api.refresh.mockReturnValue(flight.promise);
    useNavigationStore.getState().startTransitNavigation(trip("initial"));
    const initial = useNavigationStore.getState().itinerary;
    renderHook(() => useTransitLiveRefresh(true));
    act(() => vi.advanceTimersByTime(30_000));
    act(() => useNavigationStore.getState().setTransitRerouteNeeded(true));
    await act(async () => flight.resolve({ data: { itinerary: trip("obsolete") } }));
    act(() => vi.advanceTimersByTime(90_000));
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().itinerary).toBe(initial);
  });
  it("invalidates a pending response on deactivation and starts a fresh interval", async () => {
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
    api.refresh.mockResolvedValue({ data: { itinerary: trip("fresh") } });
    view.rerender({ active: true });
    act(() => vi.advanceTimersByTime(29_999));
    expect(api.refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(useNavigationStore.getState().itinerary?.refreshToken).toBe("fresh");
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
