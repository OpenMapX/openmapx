import { useNavigationStore } from "@openmapx/core";
import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransitJourneySheet } from "./TransitJourneySheet";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (v: string) => v.slice(11, 16) }),
}));
vi.mock("@/lib/mobile/useMobileRuntime", () => ({
  useMobileRuntime: () => ({ browserAuthority: false }),
}));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useVehicleJourney: () => ({ isError: false }),
}));
const time = (clock: string) => `2026-11-06T${clock}:00Z`;
const leg: TripLeg = {
  mode: "bus",
  tripId: "bus-21",
  route: { shortName: "21", longName: "" },
  from: { name: "Bushof", lat: 50, lng: 6 },
  to: { name: "Liebigstraße", lat: 50.01, lng: 6.01 },
  geometry: {
    type: "LineString",
    coordinates: [
      [6, 50],
      [6.01, 50.01],
    ],
  },
  startTime: time("08:45"),
  scheduledStartTime: time("08:44"),
  endTime: time("08:53"),
  scheduledEndTime: time("08:52"),
  durationSeconds: 480,
  realtime: true,
};
const itinerary = {
  legs: [leg],
  duration: 480,
  startTime: leg.startTime,
  endTime: leg.endTime,
  transfers: 0,
  walkDistance: 0,
} satisfies TripItinerary;
afterEach(() => useNavigationStore.getState().stopNavigation());
it("shows captured stop delays without delaySeconds and anchors endpoints to the leg", () => {
  const stops = [
    { name: "Bushof", scheduledDeparture: time("08:44"), expectedDeparture: time("08:46") },
    { name: "Hansemannplatz", scheduledDeparture: time("08:46"), expectedDeparture: time("08:47") },
    {
      name: "Dwell",
      scheduledArrival: time("08:47"),
      expectedArrival: time("08:48"),
      scheduledDeparture: time("08:49"),
      expectedDeparture: time("08:49"),
    },
    {
      name: "Skipped",
      scheduledDeparture: time("08:50"),
      expectedDeparture: time("08:51"),
      canceled: true,
    },
    { name: "Liebigstraße", scheduledArrival: time("08:52"), expectedArrival: time("08:54") },
  ].map((s, i) => ({ ...s, stopId: String(i), lat: 50, lng: 6 }));
  useNavigationStore.setState({
    transitCaptures: [
      { legIndex: 0, tripId: "bus-21", status: "captured", capturedAtMs: 0, stops },
    ],
  });
  render(<TransitJourneySheet itinerary={itinerary} currentLegIndex={0} transitProgress={null} />);
  expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:45")).toBeInTheDocument();
  expect(screen.getByText("08:46")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:47")).toBeInTheDocument();
  expect(screen.getByText("08:49")).not.toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:52")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:53")).toBeInTheDocument();
  expect(screen.queryByText("08:54")).toBeNull();
  expect(screen.queryByText("08:48")).toBeNull();
  expect(screen.getAllByText("navigation.delayMinutes")).toHaveLength(3);
  expect(screen.getAllByText("navigation.stopSkipped")).toHaveLength(1);
  expect(screen.queryByText("transit.canceled")).toBeNull();
});
it("shows delay on an upcoming selected ride", () => {
  render(
    <TransitJourneySheet
      itinerary={{ ...itinerary, legs: [leg, { ...leg, tripId: "next-ride" }] }}
      currentLegIndex={0}
      transitProgress={null}
    />,
  );
  expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:45")).toBeInTheDocument();
  expect(screen.getByText("navigation.delayMinutes")).toBeInTheDocument();
});
