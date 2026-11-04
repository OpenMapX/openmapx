import { apiClient, useNavigationStore } from "@openmapx/core";
import { freshTransitTickState } from "@openmapx/core/navigation";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

import { useTransitWalkRepair } from "./useTransitWalkRepair";

function start(wheelchair = false) {
  const trip = {
    duration: 1000,
    startTime: "",
    endTime: "",
    transfers: 0,
    walkDistance: 200,
    legs: [
      {
        mode: "walking",
        from: { name: "Here", lat: 0, lng: 0 },
        to: { name: "Board", lat: 0, lng: 0.002 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.002, 0],
          ],
        },
      },
      {
        mode: "bus",
        tripId: "chosen",
        route: { shortName: "12" },
        from: { name: "Board", lat: 0, lng: 0.002 },
        to: { name: "End", lat: 0, lng: 0.02 },
      },
    ],
  } as TripItinerary;
  useNavigationStore.getState().startTransitNavigation(trip, { wheelchairRequired: wheelchair });
  useNavigationStore.setState({
    transitTickState: freshTransitTickState(Date.now(), trip),
    transitProgress: {
      currentLegIndex: 0,
      phase: "walking",
      position: [0.001, 0.001],
      positionTimestampMs: Date.now() - 5000,
      snapped: [0.001, 0],
      deviationMeters: 100,
      fractionAlongLeg: 0.5,
      arrived: false,
    },
  });
  return trip;
}
function nextFix() {
  act(() =>
    useNavigationStore.setState((s) =>
      s.transitProgress
        ? {
            transitProgress: { ...s.transitProgress, positionTimestampMs: Date.now() },
          }
        : {},
    ),
  );
}
afterEach(() => {
  useNavigationStore.getState().stopNavigation();
  vi.restoreAllMocks();
});
it("repairs walking to the same stop without replacing the selected bus", async () => {
  const original = start();
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({
    routes: [
      {
        mode: "walking",
        geometry: [
          [0.001, 0.001],
          [0.002, 0],
        ],
        steps: [
          {
            instruction: "Continue",
            distance: 200,
            duration: 150,
            coordinates: [
              [0.001, 0.001],
              [0.002, 0],
            ],
          },
        ],
        distance: 200,
        duration: 150,
      },
    ],
  });
  renderHook(() => useTransitWalkRepair());
  nextFix();
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(useNavigationStore.getState().itinerary?.legs[0].steps?.[0].instructionText).toBe(
      "Continue",
    ),
  );
  expect(useNavigationStore.getState().itinerary?.legs[1]).toBe(original.legs[1]);
  expect(get.mock.calls[0][1]).toMatchObject({ mode: "walking", waypoints: "0.001,0.001;0.002,0" });
});
it("keeps an accessibility requirement rather than querying a provider without that contract", () => {
  start(true);
  const get = vi.spyOn(apiClient, "get");
  const { result } = renderHook(() => useTransitWalkRepair());
  nextFix();
  expect(get).not.toHaveBeenCalled();
  expect(result.current).toBe("accessibility");
});
it("drops a walking repair once the rider has boarded", async () => {
  const original = start();
  let finish: (v: unknown) => void = () => {};
  vi.spyOn(apiClient, "get").mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  renderHook(() => useTransitWalkRepair());
  nextFix();
  act(() => useNavigationStore.getState().applyTransitAction({ type: "board", legIndex: 1 }));
  await act(async () =>
    finish({
      routes: [
        {
          mode: "walking",
          geometry: [
            [0.001, 0.001],
            [0.002, 0],
          ],
          steps: [],
          distance: 200,
          duration: 150,
        },
      ],
    }),
  );
  expect(useNavigationStore.getState().itinerary).toBe(original);
});
