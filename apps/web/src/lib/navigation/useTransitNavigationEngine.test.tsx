import { apiClient, type FixInput, useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { act } from "@testing-library/react";
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

import { renderHookWithQuery } from "@/test/query";
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
  vi.restoreAllMocks();
  map.easeTo.mockClear();
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
it("rejects a refresh that changes the selected vehicle", () => {
  useNavigationStore.getState().startTransitNavigation(trip());
  const original = useNavigationStore.getState().itinerary;
  const other = trip();
  other.legs[0].tripId = "another";
  useNavigationStore.getState().updateItinerary(other);
  expect(useNavigationStore.getState().itinerary).toBe(original);
  expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
});
