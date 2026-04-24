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

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    if (namespace === "common" && key === "back") return "Back";
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
  useDepartures: () => ({ data: departures, isLoading: false }),
  useArrivals: () => ({ data: [], isLoading: false }),
  useStopAlerts: () => ({ data: alerts }),
  useProviders: () => ({
    data: [{ id: "entur", label: "Entur", url: "https://entur.no", license: "CC-BY 4.0" }],
  }),
  resolveProvider: (providers: Array<{ id: string; label: string }>, providerId: string) =>
    providers.find((provider) => provider.id === providerId) ?? {
      id: providerId,
      label: providerId,
    },
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
    expect(markup).toContain("Entur");
  });
});
