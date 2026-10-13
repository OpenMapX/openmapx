import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";

const values = vi.hoisted(() => {
  const row = (id: string, mode: string, name: string) => ({
    tripId: id,
    scheduledAt: "2026-01-01T00:00:00Z",
    headsign: id,
    route: { id, shortName: id, longName: "", mode },
    contributors: [{ sourceId: id, name }],
  });
  return {
    departures: [row("a", "rail", "Rail supplier A"), row("b", "bus", "Hidden bus B")],
    arrivals: [row("d", "rail", "Arrival supplier D")],
  };
});
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@openmapx/core", () => ({
  useLinkedTransitDepartures: () => ({
    data: values.departures,
    attributions: [{ sourceId: "z", name: "Envelope Z" }],
    isLoading: false,
  }),
  useLinkedTransitArrivals: () => ({ data: values.arrivals, attributions: [], isLoading: false }),
  useLinkedTransitAlerts: () => ({
    data: [],
    attributions: [{ sourceId: "x", name: "Hidden alerts X" }],
  }),
}));
vi.mock("./DepartureRow", () => ({
  DepartureRow: ({ departure }: { departure: { tripId: string } }) => <div>{departure.tripId}</div>,
}));
vi.mock("@/components/ui/AttributionStrip", () => ({
  AttributionStrip: ({ attributions }: { attributions: Array<{ name: string }> }) => (
    <div data-testid="credits">{attributions.map((receipt) => receipt.name).join(";")}</div>
  ),
}));

import { PlaceDeparturesView } from "./PlaceDeparturesView";

describe("displayed board provenance", () => {
  it("credits only the active tab and selected mode", () => {
    render(
      <PlaceDeparturesView
        place={{ name: "Stop" } as never}
        modeFilter="rail"
        onBack={() => {}}
        onDepartureClick={() => {}}
      />,
    );
    expect(screen.getByTestId("credits").textContent).toBe("Rail supplier A");
    fireEvent.click(screen.getByRole("button", { name: "arrivals" }));
    expect(screen.getByTestId("credits").textContent).toBe("Arrival supplier D");
  });
});
