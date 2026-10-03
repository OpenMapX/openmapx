import { useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { act, renderHook } from "@testing-library/react";
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
