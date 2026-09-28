import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransitItineraryCard } from "./TransitRouteView";
import { SAMPLE_TRANSIT_ITINERARY } from "./TransitRouteView.fixtures";

vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (v: string | number | Date) => String(v),
    date: (v: string | number | Date) => String(v),
    dateTime: (v: string | number | Date) => String(v),
  }),
}));

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    if (namespace === "directions" && key === "transfers") {
      return `${String(values?.count ?? 0)} transfer`;
    }
    if (namespace === "directions" && key === "walkDistance") {
      return `${String(values?.distance ?? "")} walk`;
    }
    if (namespace === "directions" && key === "lowestCo2") return "Lowest CO₂";
    if (namespace === "directions" && key === "co2Emissions") return "CO₂";
    if (namespace === "directions" && key === "cancelledServices") {
      const count = Number(values?.count ?? 0);
      return `${count} ${count === 1 ? "service" : "services"} cancelled`;
    }
    if (namespace === "directions" && key === "wheelchairRestrictedLegs") {
      const count = Number(values?.count ?? 0);
      return `${count} ${count === 1 ? "leg" : "legs"} not wheelchair accessible`;
    }
    if (namespace === "common" && key === "details") return "Details";
    return key;
  },
  useLocale: () => "en",
}));

afterEach(cleanup);

const itineraryWith = (legs: TripItinerary["legs"]): TripItinerary => ({
  ...SAMPLE_TRANSIT_ITINERARY,
  legs,
});

const railLeg = SAMPLE_TRANSIT_ITINERARY.legs[0];

vi.mock("@openmapx/core", () => ({
  formatDistance: (distance: number) => `${distance} m`,
  formatDuration: (duration: number) => `${duration}s`,
  useVehicleJourney: () => ({ data: null }),
  useRefreshTransitItinerary: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSettingsStore: (sel: (s: { units: string }) => unknown) => sel({ units: "metric" }),
  useNavigationStore: Object.assign(
    (sel: (s: { startTransitNavigation: () => void }) => unknown) =>
      sel({ startTransitNavigation: () => {} }),
    { getState: () => ({ startTransitNavigation: () => {} }) },
  ),
}));

vi.mock("@/components/panels/transit/RouteBadge", () => ({
  RouteBadge: ({ shortName }: { shortName: string }) => <span>{shortName}</span>,
}));

vi.mock("@/components/panels/transit/RemarkChip", () => ({
  RemarkChip: () => null,
}));

vi.mock("@/lib/fareUtils", () => ({
  extractFareSummary: () => null,
  formatFare: () => "",
}));

vi.mock("@/integration-api/runtime/theme", () => ({
  BRAND: "#0f9d58",
  BRAND_HEX: "#0f9d58",
}));

vi.mock("@/lib/transitOccupancy", () => ({
  OCCUPANCY_COLOR: { low: "#0f9d58", medium: "#fbbc04", high: "#f57c00", overcrowded: "#d93025" },
  OCCUPANCY_KEY: { low: "low", medium: "medium", high: "high", overcrowded: "overcrowded" },
}));

describe("TransitItineraryCard", () => {
  it("renders a first-class CO2 badge for the lowest-emission itinerary", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={SAMPLE_TRANSIT_ITINERARY}
        active={false}
        isLowestCo2
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );

    expect(markup).toContain("1 transfer");
    expect(markup).toContain("250 m walk");
    expect(markup).toContain("Lowest CO₂");
    expect(markup).toContain("43 g CO₂");
    expect(markup).not.toContain("cancelled");
    expect(markup).not.toContain("not wheelchair accessible");
  });

  it("counts confirmed cancellations across multiple legs", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={itineraryWith([
          { ...railLeg, cancelled: true },
          { ...railLeg, cancelled: false },
          { ...railLeg, cancelled: true },
        ])}
        active={false}
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );
    expect(markup).toContain("2 services cancelled");
    expect(markup).not.toContain("not wheelchair accessible");
  });

  it("summarizes only confirmed wheelchair restrictions", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={itineraryWith([
          { ...railLeg, wheelchairAccessible: true },
          { ...railLeg, wheelchairAccessible: false },
          { ...railLeg },
        ])}
        active={false}
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );
    expect(markup).toContain("1 leg not wheelchair accessible");
    expect(markup).not.toMatch(/\b(?:service|services) cancelled\b/i);
  });

  it("shows both confirmed conditions without treating unknown legs as clear", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={itineraryWith([
          { ...railLeg, cancelled: true },
          { ...railLeg, wheelchairAccessible: false },
          { ...railLeg },
        ])}
        active={false}
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );
    expect(markup).toContain("1 service cancelled");
    expect(markup).toContain("1 leg not wheelchair accessible");
    expect(markup).not.toContain("Wheelchair accessible");
  });

  it("does not infer cancellation from a severe alert or unknown accessibility", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={itineraryWith([
          {
            ...railLeg,
            alerts: [
              {
                id: "maintenance",
                providers: ["test"],
                severity: "severe",
                title: "Service disruption",
                affectedRouteIds: [],
                affectedStopIds: [],
                activePeriods: [],
              },
            ],
          },
        ])}
        active={false}
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );
    expect(markup).not.toMatch(/\b(?:service|services) cancelled\b/i);
    expect(markup).not.toContain("not wheelchair accessible");
  });

  it("keeps itinerary selection and Details separate when a warning is present", () => {
    const onSelect = vi.fn();
    const onDetails = vi.fn();
    const view = render(
      <TransitItineraryCard
        itinerary={itineraryWith([{ ...railLeg, cancelled: true }])}
        active
        onSelect={onSelect}
        onDetails={onDetails}
      />,
    );
    fireEvent.click(view.container.querySelector('[role="button"]') as Element);
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Details"));
    expect(onDetails).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
