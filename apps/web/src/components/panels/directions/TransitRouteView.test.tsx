import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
    if (namespace === "directions" && key === "lowestCo2") return "Lowest CO2";
    if (namespace === "directions" && key === "co2Emissions") return "CO2";
    if (namespace === "common" && key === "details") return "Details";
    return key;
  },
  useLocale: () => "en",
}));

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
    expect(markup).toContain("Lowest CO2");
    expect(markup).toContain("43 g CO2");
  });
});
