import type { VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LiveStopTime } from "./TransitRouteView";

const query = vi.hoisted(() => ({ stops: [] as VehicleJourneyStop[] }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useVehicleJourney: () => ({ data: query }),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (v: string) => v.slice(11, 16) }),
}));
vi.mock("@/components/ui/AttributionStrip", () => ({
  AttributionStrip: ({ attributions }: { attributions: Array<{ name: string }> }) => (
    <span>{attributions.map((a) => a.name).join(", ")}</span>
  ),
}));
const at = (clock: string) => `2026-11-06T${clock}:00Z`;
it("uses explicit departure timestamps, without relying on numeric delay hints", () => {
  query.stops = [
    {
      stopId: "stop",
      name: "Stop",
      lat: 50,
      lng: 6,
      scheduledArrival: at("08:43"),
      expectedArrival: at("08:44"),
      scheduledDeparture: at("08:44"),
      expectedDeparture: at("08:45"),
      contributors: [{ sourceId: "live", name: "Prediction supplier" }],
    },
  ];
  render(<LiveStopTime time={{ scheduledAt: at("08:44") }} tripId="trip" stopId="stop" />);
  expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:45")).toBeInTheDocument();
  expect(screen.getByText("navigation.delayMinutes")).toBeInTheDocument();
  expect(screen.getByText("Prediction supplier")).toBeInTheDocument();
});
it("uses the arrival pair for arrival rows, including dwell time", () => {
  query.stops = [
    {
      stopId: "stop",
      name: "Stop",
      lat: 50,
      lng: 6,
      scheduledArrival: at("08:43"),
      expectedArrival: at("08:44"),
      scheduledDeparture: at("08:45"),
      expectedDeparture: at("08:45"),
    },
  ];
  render(
    <LiveStopTime
      time={{ scheduledAt: at("08:43") }}
      event="arrival"
      tripId="trip"
      stopId="stop"
    />,
  );
  expect(screen.getByText("08:43")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:44")).toBeInTheDocument();
  expect(screen.queryByText("08:45")).toBeNull();
});
it("retains itinerary evidence before the independent vehicle query is available", () => {
  query.stops = [];
  render(
    <LiveStopTime
      time={{ scheduledAt: at("08:44"), expectedAt: at("08:45") }}
      tripId="trip"
      stopId="stop"
    />,
  );
  expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("08:45")).toBeInTheDocument();
});

it.each(["departure", "arrival"] as const)(
  "does not replace an itinerary prediction with a timetable-only %s lookup",
  (event) => {
    query.stops = [
      {
        stopId: "stop",
        name: "Stop",
        lat: 50,
        lng: 6,
        scheduledDeparture: at("08:44"),
        scheduledArrival: at("08:44"),
        contributors: [{ sourceId: "timetable", name: "Timetable-only supplier" }],
      },
    ];
    render(
      <LiveStopTime
        time={{ scheduledAt: at("08:44"), expectedAt: at("08:45") }}
        event={event}
        tripId="trip"
        stopId="stop"
      />,
    );
    expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
    expect(screen.getByText("08:45")).toBeInTheDocument();
    expect(screen.getByText("navigation.delayMinutes")).toBeInTheDocument();
    expect(screen.queryByText("Timetable-only supplier")).toBeNull();
  },
);
