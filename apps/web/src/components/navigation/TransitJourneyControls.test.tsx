import { useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  browserAuthority: true,
  capabilities: { transitActions: true },
}));
vi.mock("@/lib/mobile/useMobileRuntime", () => ({ useMobileRuntime: () => platform }));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { TransitJourneyControls } from "./TransitJourneyControls";

afterEach(() => {
  useNavigationStore.getState().stopNavigation();
  platform.browserAuthority = true;
});
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

it.each([
  {
    realtime: true,
    unavailable: false,
    token: undefined,
    label: "navigation.departureLive",
    native: true,
  },
  { realtime: true, unavailable: true, token: "refresh", label: "navigation.departureLastKnown" },
  { realtime: true, unavailable: false, token: "refresh", label: "navigation.departureLive" },
  { realtime: false, unavailable: true, token: "refresh", label: "navigation.departureScheduled" },
  { realtime: true, unavailable: false, token: undefined, label: "navigation.departureLastKnown" },
])(
  "labels departure freshness honestly: $label / unavailable=$unavailable",
  ({ realtime, unavailable, token, label, native }) => {
    platform.browserAuthority = !native;
    useNavigationStore.getState().startTransitNavigation({
      duration: 1200,
      startTime: "",
      endTime: "",
      transfers: 0,
      walkDistance: 0,
      refreshToken: token,
      legs: [
        {
          mode: "bus",
          tripId: "bus",
          realtime,
          route: { shortName: "12" },
          from: { name: "Stop", lat: 0, lng: 0 },
          to: { name: "End", lat: 0, lng: 0.01 },
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [0.01, 0],
            ],
          },
          startTime: new Date(Date.now() + 300000).toISOString(),
          endTime: "",
        },
      ],
    } as TripItinerary);
    useNavigationStore.getState().setLiveDataUnavailable(unavailable);
    render(<TransitJourneyControls onAlternatives={() => {}} />);
    expect(screen.getByText(label)).toBeTruthy();
    if (label !== "navigation.departureLive")
      expect(screen.queryByText("navigation.departureLive")).toBeNull();
    expect(!!screen.queryByText("navigation.transitLiveUpdatesUnavailable")).toBe(unavailable);
  },
);

it.each([
  { realtime: true, unavailable: true, label: "navigation.departureLastKnown" },
  { realtime: false, unavailable: false, label: "navigation.departureLastKnown" },
  { realtime: true, unavailable: false, label: "navigation.departureLive" },
])("keeps a +1 delay visible with $label", ({ realtime, unavailable, label }) => {
  const scheduled = new Date(Math.floor((Date.now() + 300000) / 60000) * 60000).toISOString();
  const expected = new Date(Date.parse(scheduled) + 60000).toISOString();
  useNavigationStore.getState().startTransitNavigation({
    duration: 1200,
    startTime: scheduled,
    endTime: expected,
    transfers: 0,
    walkDistance: 0,
    refreshToken: "refresh",
    legs: [
      {
        mode: "bus",
        tripId: "bus",
        realtime,
        route: { shortName: "21" },
        from: { name: "Bushof", lat: 0, lng: 0 },
        to: { name: "Liebigstraße", lat: 0, lng: 0.01 },
        startTime: expected,
        scheduledStartTime: scheduled,
        endTime: expected,
      },
    ],
  } as TripItinerary);
  useNavigationStore.getState().setLiveDataUnavailable(unavailable);
  render(<TransitJourneyControls onAlternatives={() => {}} />);
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText("navigation.delayMinutes")).toBeInTheDocument();
  if (unavailable) expect(screen.queryByText("navigation.departureLive")).toBeNull();
});
