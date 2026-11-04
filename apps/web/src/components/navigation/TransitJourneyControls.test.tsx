import { useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { TransitJourneyControls } from "./TransitJourneyControls";

afterEach(() => useNavigationStore.getState().stopNavigation());
it("requires explicit boarding, then provides alighting and undo", async () => {
  const itinerary = {
    legs: [
      {
        mode: "bus",
        tripId: "bus",
        from: { name: "Central", lat: 0, lng: 0 },
        to: { name: "Museum", lat: 0, lng: 0.01 },
        route: { shortName: "12" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.01, 0],
          ],
        },
        startTime: "2026-11-04T12:00:00Z",
        endTime: "2026-11-04T12:20:00Z",
      },
    ],
    duration: 1200,
    startTime: "",
    endTime: "",
    transfers: 0,
    walkDistance: 0,
  } as TripItinerary;
  useNavigationStore.getState().startTransitNavigation(itinerary);
  render(<TransitJourneyControls onAlternatives={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "navigation.confirmBoard" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "navigation.confirmAlight" })).toBeTruthy(),
  );
  expect(useNavigationStore.getState().transitProgress?.phase).toBe("riding");
  fireEvent.click(screen.getByRole("button", { name: "navigation.undoTransitAction" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "navigation.confirmBoard" })).toBeTruthy(),
  );
});
it("does not suggest boarding while walking correctly toward a distant stop", () => {
  const itinerary = {
    legs: [
      {
        mode: "walking",
        from: { name: "Home", lat: 0, lng: 0 },
        to: { name: "Stop", lat: 0, lng: 0.02 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.02, 0],
          ],
        },
      },
      {
        mode: "bus",
        tripId: "bus",
        route: { shortName: "12" },
        from: { name: "Stop", lat: 0, lng: 0.02 },
        to: { name: "End", lat: 0, lng: 0.03 },
      },
    ],
  } as TripItinerary;
  useNavigationStore.getState().startTransitNavigation(itinerary);
  useNavigationStore.getState().applyTransitProgress({
    currentLegIndex: 0,
    phase: "walking",
    position: [0.001, 0],
    positionTimestampMs: Date.now(),
    snapped: [0.001, 0],
    deviationMeters: 0,
    fractionAlongLeg: 0.05,
    arrived: false,
  });
  render(<TransitJourneyControls onAlternatives={() => {}} />);
  expect(screen.queryByText("navigation.boardPrompt")).toBeNull();
});
