import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StopBoardView } from "./StopBoardView";

const departures = [
  {
    tripId: "entur:2026-04-22|VYG:ServiceJourney:1",
    route: {
      id: "entur:VYG:Line:R14",
      shortName: "R14",
      longName: "Asker-Oslo S-Kongsvinger",
      mode: "rail",
      color: "DF2027",
    },
    headsign: "Kongsvinger",
    scheduledAt: "2026-04-22T10:00:00+02:00",
    platform: "11",
  },
];

const alerts = [
  {
    id: "alert-1",
    providers: ["entur"],
    severity: "severe",
    title: "Platform change",
    affectedRouteIds: ["entur:VYG:Line:R14"],
    affectedStopIds: ["entur:NSR:StopPlace:337"],
    activePeriods: [{ start: "2026-04-22T09:00:00+02:00" }],
  },
];

const sharedAttributions = [
  { sourceId: "entur", name: "Entur", url: "https://entur.no", spdxLicense: "CC-BY-4.0" },
];

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    if (namespace === "common" && key === "back") return "Back";
    if (namespace === "common" && key === "dataSources") return "Data sources";
    if (key === "noDeparturesGeneric") return `No ${String(values?.tab ?? "departures")} found.`;
    return (
      {
        departures: "Departures",
        arrivals: "Arrivals",
      }[key] ?? key
    );
  },
}));

vi.mock("@openmapx/core", () => ({
  useDepartures: () => ({
    data: departures,
    isLoading: false,
    attributions: sharedAttributions,
  }),
  useArrivals: () => ({ data: [], isLoading: false, attributions: [] }),
  useStopAlerts: () => ({ data: alerts, attributions: [] }),
}));

vi.mock("@/components/ui/AttributionStrip", () => ({
  AttributionStrip: ({ attributions }: { attributions: Array<{ name: string }> }) => (
    <div data-testid="attribution-strip">{attributions.map((a) => a.name).join(" · ")}</div>
  ),
}));

vi.mock("@/lib/useAttributionFromHooks", () => ({
  useAttributionFromHooks: () => sharedAttributions,
}));

vi.mock("./DepartureRow", () => ({
  DepartureRow: ({
    departure,
    hasAlert,
  }: {
    departure: { headsign: string; route: { id: string } };
    hasAlert?: boolean;
  }) => <div>{`${departure.headsign}:${hasAlert ? "alert" : "ok"}`}</div>,
}));

vi.mock("./AlertsBanner", () => ({
  AlertsBanner: ({ alerts: alertItems }: { alerts: Array<{ title: string }> }) => (
    <div>{alertItems.map((alert) => alert.title).join(" | ")}</div>
  ),
}));

describe("StopBoardView", () => {
  it("renders stop alerts and flags severe affected routes", () => {
    const markup = renderToStaticMarkup(
      <StopBoardView
        stopId="entur:NSR:StopPlace:337"
        title="Oslo S"
        onBack={() => {}}
        onDepartureClick={() => {}}
      />,
    );

    expect(markup).toContain("Platform change");
    expect(markup).toContain("Kongsvinger:alert");
    // AttributionStrip mock renders source names — confirms strip is wired.
    expect(markup).toContain("Entur");
  });
});
