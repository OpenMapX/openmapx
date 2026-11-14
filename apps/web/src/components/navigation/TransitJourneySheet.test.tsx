import { type TransitProgress, useNavigationStore } from "@openmapx/core";
import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { fireEvent, render, screen } from "@testing-library/react";
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
  headsign: "Palenberg Bahnhof",
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
  fireEvent.click(screen.getByRole("button", { name: "navigation.showIntermediateStops" }));
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

function captureStops(urgent = false) {
  const stops = [
    "Bushof",
    "Hansemannplatz",
    "Blücherplatz",
    "Ludwig Forum",
    "Talbot",
    "Liebigstraße",
  ].map((name, i) => ({
    name,
    stopId: String(i),
    lat: 50,
    lng: 6,
    scheduledDeparture: time(`08:${44 + i}`),
    ...(urgent && i === 3 ? { canceled: true } : {}),
    ...(urgent && i === 4
      ? {
          alerts: [
            {
              id: "lift",
              title: "Lift out of service",
              severity: "warning" as const,
              providers: [],
              affectedRouteIds: [],
              affectedStopIds: [],
              activePeriods: [],
            },
          ],
        }
      : {}),
  }));
  useNavigationStore.setState({
    transitCaptures: [
      { legIndex: 0, tripId: "bus-21", status: "captured", capturedAtMs: 0, stops },
    ],
  });
}
const riding = (cursor: number, confidence?: TransitProgress["confidence"]): TransitProgress => ({
  currentLegIndex: 0,
  phase: "riding",
  stopCursor: cursor,
  confidence,
  snapped: [6, 50],
  fractionAlongLeg: 0.2,
  deviationMeters: 0,
  arrived: false,
});

it("discloses ordinary intermediate stops without hiding endpoints or their delays", () => {
  captureStops();
  render(<TransitJourneySheet itinerary={itinerary} currentLegIndex={0} transitProgress={null} />);
  expect(screen.getByText("Bushof")).toBeVisible();
  expect(screen.getByText("Liebigstraße")).toBeVisible();
  expect(screen.queryByText("Blücherplatz")).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "navigation.showIntermediateStops" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.getByText("Blücherplatz")).toBeVisible();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
});
it("shows skipped stops and alert text without needing a disclosure or hover", () => {
  captureStops(true);
  render(<TransitJourneySheet itinerary={itinerary} currentLegIndex={0} transitProgress={null} />);
  expect(screen.getByText("Ludwig Forum")).toBeVisible();
  expect(screen.getByText("navigation.stopSkipped")).toBeVisible();
  expect(screen.getByText("Lift out of service")).toBeVisible();
  expect(screen.queryByText("Hansemannplatz")).not.toBeInTheDocument();
});
it.each(["uncertain", "stale", undefined] as const)(
  "exposes future stops when riding confidence is %s",
  (confidence) => {
    captureStops();
    render(
      <TransitJourneySheet
        itinerary={itinerary}
        currentLegIndex={0}
        transitProgress={riding(2, confidence)}
      />,
    );
    expect(screen.getByText("Blücherplatz")).toBeVisible();
    expect(screen.getByText("Ludwig Forum")).toBeVisible();
    expect(screen.getByText("Talbot")).toBeVisible();
    expect(screen.queryByText("navigation.nextStopLabel")).not.toBeInTheDocument();
  },
);
it("keeps a focused disclosure through progress updates and resets it for another leg", () => {
  captureStops();
  const view = render(
    <TransitJourneySheet
      itinerary={itinerary}
      currentLegIndex={0}
      transitProgress={riding(1, "gps")}
    />,
  );
  const toggle = screen.getByRole("button", { name: "navigation.showIntermediateStops" });
  fireEvent.click(toggle);
  toggle.focus();
  view.rerender(
    <TransitJourneySheet
      itinerary={itinerary}
      currentLegIndex={0}
      transitProgress={riding(4, "gps")}
    />,
  );
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const next = { ...leg, tripId: "bus-22" };
  const held = useNavigationStore.getState().transitCaptures[0];
  useNavigationStore.setState({ transitCaptures: [{ ...held, tripId: "bus-22" }] });
  view.rerender(
    <TransitJourneySheet
      itinerary={{ ...itinerary, legs: [next] }}
      currentLegIndex={0}
      transitProgress={null}
    />,
  );
  expect(screen.getByRole("button", { name: "navigation.showIntermediateStops" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
it("keeps boarding visible while previous stops can be expanded", () => {
  captureStops();
  render(
    <TransitJourneySheet
      itinerary={itinerary}
      currentLegIndex={0}
      transitProgress={riding(3, "gps")}
    />,
  );
  expect(screen.getByText("Bushof")).toBeVisible();
  expect(screen.queryByText("Hansemannplatz")).not.toBeInTheDocument();
  expect(screen.getByText("Ludwig Forum")).toBeVisible();
  expect(screen.getByText("navigation.nextStopLabel")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "navigation.showPreviousStops" }));
  expect(screen.getByText("Hansemannplatz")).toBeVisible();
});

it("keeps full vehicle and operator identity in expanded ride details", () => {
  const selected = {
    ...leg,
    category: "Bus",
    tripShortName: "21019",
    operatorName: "Aachener Straßenbahn- und Energieversorgungs-AG",
  };
  render(
    <TransitJourneySheet
      itinerary={{ ...itinerary, legs: [selected] }}
      currentLegIndex={0}
      transitProgress={null}
    />,
  );
  expect(
    screen.getByText("Bus 21019 · Aachener Straßenbahn- und Energieversorgungs-AG"),
  ).toBeVisible();
});
