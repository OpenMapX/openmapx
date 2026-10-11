import type { Place } from "@openmapx/core";
import type { Departure } from "@openmapx/mobility-core/transit";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransitBoardingDepartures } from "@/components/navigation/TransitBoardingDepartures";
import { DepartureRow } from "./DepartureRow";
import { PlaceDeparturesView } from "./PlaceDeparturesView";
import { PlaceTransitSection } from "./PlaceTransitSection";
import { StopBoardView } from "./StopBoardView";

const state = vi.hoisted(() => ({
  routesAvailable: true,
  routesLoading: false,
  query: {
    data: [] as Departure[] | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    freshness: {
      fetchedAt: "2026-10-07T08:00:00Z",
      hasRealtimeData: true,
      isStale: false,
      isPartial: false,
    },
    refetch: vi.fn(),
  },
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (v: string) => v.slice(11, 16) }),
}));
vi.mock("@openmapx/core", () => ({
  routeColor: () => "#333333",
  useDepartures: () => state.query,
  useLinkedTransitDepartures: () => state.query,
  useLinkedTransitArrivals: () => ({ data: [], isLoading: false }),
  useLinkedTransitRoutes: () => ({
    data: state.routesAvailable
      ? [{ id: "ms:route-a", shortName: "RE1", longName: "", mode: "rail", providers: ["ms"] }]
      : [],
    isLoading: state.routesLoading,
  }),
  useLinkedTransitFacilities: () => ({ data: [] }),
  useLinkedTransitAlerts: () => ({ data: [] }),
  useArrivals: () => ({ data: [], isLoading: false }),
  useStopAlerts: () => ({ data: [] }),
}));
vi.mock("@/integration-api/overlay/useAttributionFromHooks", () => ({
  useAttributionFromHooks: () => [],
}));
vi.mock("@/components/ui/AttributionStrip", () => ({ AttributionStrip: () => null }));
const departure: Departure = {
  tripId: "ms:trip-a",
  route: { id: "ms:route-a", shortName: "RE1", longName: "", mode: "rail" },
  headsign: "Sibling station",
  scheduledAt: "2026-10-07T08:05:00Z",
  expectedAt: "2026-10-07T08:08:00Z",
  delaySeconds: 180,
  platform: "4",
  scheduledPlatform: "3",
  provenance: {
    baselineSource: "gtfs",
    instance: "transit-motis-local",
    realtimeCompleteness: "merged",
    observedAt: "2026-10-07T08:00:00Z",
  },
};
beforeEach(() => {
  state.routesAvailable = true;
  state.routesLoading = false;
  state.query = {
    data: [departure],
    isLoading: false,
    isError: false,
    isFetching: false,
    freshness: {
      fetchedAt: "2026-10-07T08:00:00Z",
      hasRealtimeData: true,
      isStale: false,
      isPartial: false,
    },
    refetch: vi.fn(),
  };
});
describe("departure uncertainty and identity", () => {
  it("shows planned and predicted times, changed platforms and cancellation in text", () => {
    const { rerender } = render(
      <DepartureRow departure={departure} now={Date.parse("2026-10-07T08:00:00Z")} />,
    );
    expect(screen.getByText("08:05")).toBeInTheDocument();
    expect(screen.getByText("08:08")).toBeInTheDocument();
    expect(screen.getByText(/3 → 4/)).toHaveTextContent("transit.platformChanged");
    expect(
      screen.queryByText(/dataStatus.realtime|dataStatus.unknown|dataStatus.local/),
    ).not.toBeInTheDocument();
    rerender(<DepartureRow departure={{ ...departure, canceled: true }} now={Date.now()} />);
    expect(screen.getByText("transit.canceled")).toBeInTheDocument();
    expect(screen.queryByText("08:08")).not.toBeInTheDocument();
  });
  it("retains cached rows, distinguishes sibling source identities, and retries failed refresh", () => {
    const sibling = {
      ...departure,
      tripId: "mo:trip-b",
      route: { ...departure.route, id: "mo:route-b" },
      provenance: { ...departure.provenance, instance: "mo" },
    } as Departure;
    state.query.data = [departure, sibling];
    state.query.isError = true;
    const select = vi.fn();
    render(
      <StopBoardView
        stopId="ms:stop-parent"
        title="Parent station"
        onBack={() => {}}
        onDepartureClick={select}
      />,
    );
    expect(screen.getAllByText("Sibling station")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("dataStatus.refreshFailed");
    fireEvent.click(screen.getAllByRole("button", { name: /Sibling station/ })[1]);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        tripId: "mo:trip-b",
        providers: ["mo"],
        route: expect.objectContaining({ id: "mo:route-b" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(state.query.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/noDeparturesGeneric/)).not.toBeInTheDocument();
  });
  it.each(["failed", "partial"])(
    "does not present %s empty results as confirmed no departures",
    (status) => {
      state.query.data = [];
      state.query.isError = status === "failed";
      state.query.freshness.isPartial = status === "partial";
      render(
        <StopBoardView
          stopId="ms:stop"
          title="Station"
          onBack={() => {}}
          onDepartureClick={() => {}}
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        status === "failed" ? "refreshFailed" : "partial",
      );
      expect(screen.queryByText(/noDeparturesGeneric/)).not.toBeInTheDocument();
    },
  );
});

const place = {
  id: "osm:station-parent",
  name: "Parent station",
  coordinates: [13.37, 52.52],
} as Place;
it.each(["linked board", "place preview", "boarding board"])(
  "%s retains cached service identity through failure and recovery",
  (view) => {
    state.query.isError = true;
    const component =
      view === "linked board" ? (
        <PlaceDeparturesView place={place} onBack={() => {}} onDepartureClick={() => {}} />
      ) : view === "place preview" ? (
        <PlaceTransitSection place={place} onOpenDepartures={() => {}} />
      ) : (
        <TransitBoardingDepartures
          stopId="ms:stop-sibling"
          stopName="Sibling station"
          targetTripId="ms:trip-a"
        />
      );
    const { rerender } = render(component);
    expect(screen.getByRole("status")).toHaveTextContent("dataStatus.refreshFailed");
    expect(screen.getByText("Sibling station")).toBeInTheDocument();
    state.query.isError = false;
    rerender(
      component.type === PlaceDeparturesView ? (
        <PlaceDeparturesView place={place} onBack={() => {}} onDepartureClick={() => {}} />
      ) : component.type === PlaceTransitSection ? (
        <PlaceTransitSection place={place} onOpenDepartures={() => {}} />
      ) : (
        <TransitBoardingDepartures
          stopId="ms:stop-sibling"
          stopName="Sibling station"
          targetTripId="ms:trip-a"
        />
      ),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Sibling station")).toBeInTheDocument();
  },
);

it.each([
  { expectedAt: "2026-10-07T08:03:00Z", delaySeconds: -120, clock: "08:03" },
  { expectedAt: "2026-10-07T08:06:00Z", delaySeconds: 60, clock: "08:06" },
  { expectedAt: "2026-10-07T08:07:00Z", delaySeconds: undefined, clock: "08:07" },
])("shows the differing expected time $clock independently of positive delay", (value) => {
  render(<DepartureRow departure={{ ...departure, ...value }} now={Date.now()} />);
  expect(screen.getByText(value.clock)).toBeInTheDocument();
  expect(screen.getByText("08:05")).toBeInTheDocument();
});
it.each([false, true])(
  "keeps useful departures and recovery when independent route metadata is loading=%s or absent",
  (loading) => {
    state.routesAvailable = false;
    state.routesLoading = loading;
    state.query.isError = true;
    render(<PlaceTransitSection place={place} onOpenDepartures={() => {}} />);
    expect(screen.getByText("Sibling station")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("refreshFailed");
    expect(screen.getByRole("button", { name: "common.retry" })).toBeInTheDocument();
  },
);
