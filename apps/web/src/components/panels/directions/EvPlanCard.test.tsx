import type { EvDirectionsResult } from "@openmapx/core";
import { usePlaceStore } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryWrapper, fireEvent, render, screen } from "@/test";
import { EvPlanCard } from "./EvPlanCard";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const baseResult: EvDirectionsResult = {
  routes: [
    {
      distance: 300_000,
      duration: 12_000,
      geometry: [],
      legs: [],
      steps: [],
      mode: "driving",
    },
  ],
  activeRouteIndex: 0,
  waypoints: [
    [6.08, 50.78],
    [6.95, 50.94],
  ],
  stops: [
    {
      station: { id: "c1", name: "Ionity Aachen", coordinates: [6, 50] },
      connector: "ccs2",
      powerKw: 150,
      operator: "Ionity",
      isPreferredNetwork: true,
      arriveSocPct: 12,
      departSocPct: 80,
      chargeSeconds: 1500,
      addedKwh: 40,
      availability: { available: 3, total: 6, updatedAt: "2026-07-21T10:00:00Z" },
      tariffSummary: "0.55 EUR/kWh",
      estimatedCost: { amount: 12.5, currency: "EUR" },
      attributions: [{ text: "OpenChargeMap", url: "https://openchargemap.org" }],
    },
  ],
  totals: { driveSeconds: 12_000, chargeSeconds: 1500, energyKwh: 55 },
  warnings: [],
};

describe("EvPlanCard", () => {
  it("renders each stop with power and charge time, and the total", () => {
    render(<EvPlanCard result={baseResult} />, { wrapper: createQueryWrapper() });
    screen.getByText(/Ionity Aachen/);
    screen.getByText(/150 kW/);
    expect(screen.getAllByText(/25 min/).length).toBeGreaterThan(0); // 1500s charge
  });

  it("shows the preferred-network chip for a stop on the user's network", () => {
    render(<EvPlanCard result={baseResult} />, { wrapper: createQueryWrapper() });
    screen.getByText("directions.ev.onYourNetwork");
  });

  it("opens the charger in the floating place card when a stop is clicked", () => {
    usePlaceStore.getState().setSelectedPlace(null);
    render(<EvPlanCard result={baseResult} />, { wrapper: createQueryWrapper() });

    fireEvent.click(screen.getByRole("button", { name: "Ionity Aachen" }));

    const place = usePlaceStore.getState().selectedPlace;
    // Same id space the data-source layer resolves details with, so the panel
    // fetches the real station rather than showing only the preview.
    expect(place?.ids?.["ev-charging"]).toBe("c1");
    expect(place?.name).toBe("Ionity Aachen");
    expect(place?.coordinates).toEqual([6, 50]);
  });

  it("shows an unreachable warning banner instead of the stop list", () => {
    render(
      <EvPlanCard
        result={{
          ...baseResult,
          stops: [],
          warnings: [{ kind: "unreachable", afterStopIndex: -1 }],
        }}
      />,
      { wrapper: createQueryWrapper() },
    );
    screen.getByText("directions.ev.unreachable");
    expect(screen.queryByText(/Ionity Aachen/)).toBeNull();
  });

  it("shows the no-allowed-network warning with a retry action", () => {
    const onRetry = vi.fn();
    render(
      <EvPlanCard
        result={{
          ...baseResult,
          stops: [],
          warnings: [{ kind: "no-allowed-network", afterStopIndex: 0 }],
        }}
        onRetryWithoutNetworkRestriction={onRetry}
      />,
      { wrapper: createQueryWrapper() },
    );
    screen.getByText("directions.ev.noAllowedNetwork");
    const retryButton = screen.getByText("directions.ev.routeWithoutRestriction");
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
