import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TransitItineraryCard } from "./TransitRouteView";

vi.mock("@/lib/useDateTimeFormat", () => ({
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

vi.mock("@/lib/formatTime", () => ({
  formatTime: (value: string) => value,
}));

vi.mock("@/lib/theme", () => ({
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
        itinerary={{
          duration: 164,
          startTime: "2026-04-21T22:08:16+02:00",
          endTime: "2026-04-21T22:11:00+02:00",
          transfers: 1,
          walkDistance: 250,
          co2Grams: 43.151,
          legs: [
            {
              mode: "rail",
              startTime: "2026-04-21T22:08:16+02:00",
              endTime: "2026-04-21T22:11:00+02:00",
              from: { name: "Nationaltheatret", lat: 59.915, lng: 10.728 },
              to: { name: "Oslo S", lat: 59.911, lng: 10.753 },
              route: { shortName: "R13", longName: "Drammen-Oslo S-Dal", color: "DF2027" },
              geometry: {
                type: "LineString",
                coordinates: [
                  [10.728, 59.915],
                  [10.753, 59.911],
                ],
              },
            },
          ],
        }}
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
