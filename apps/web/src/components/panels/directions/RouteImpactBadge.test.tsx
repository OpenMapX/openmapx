import type { RouteImpact } from "@openmapx/core";
import { de, en } from "@openmapx/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatImpactCost, RouteImpactBadge } from "./RouteImpactBadge";

afterEach(cleanup);

const mockDieselImpact: RouteImpact = {
  routeIndex: 0,
  vehicleId: "v1",
  vehicleName: "VW Golf 2.0 TDI",
  vehiclePowertrain: "diesel",
  occupancy: 1,
  energy: {
    fuelLiters: 4.2,
    electricityKwh: null,
    provenance: {
      kind: "calculated",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "VW Golf 2.0 TDI (5.2 L/100km)",
      assumptions: [{ kind: "base_fuel_consumption", litersPer100Km: 5.2 }],
    },
  },
  emissions: {
    totalGrams: 8400,
    tailpipeGrams: 7000,
    upstreamGrams: 1400,
    provenance: {
      kind: "defaulted",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "EEA 2024",
      assumptions: [{ kind: "tailpipe_factor", gramsPerLiter: 2640 }],
    },
  },
  cost: {
    costType: "road",
    currency: "EUR",
    energyCost: 6.8,
    tollStatus: "unknown",
    tollCost: null,
    transitFare: null,
    knownCost: 6.8,
    totalCost: null,
    costCompleteness: "partial",
    energyCostProvenance: {
      kind: "provider",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "Tankerkönig DE",
      assumptions: [{ kind: "unit_price", value: 1.62, currency: "EUR" }],
    },
  },
  comparison: {
    isLowestEmissions: true,
    isLowestCost: true,
    isFastest: true,
    emissionsDeltaGrams: -500,
    emissionsDeltaPct: -5.6,
    costDelta: -0.4,
    reason: { kind: "shorter", distanceMeters: 3200 },
  },
};

const mockEvImpactTollsUnknown: RouteImpact = {
  routeIndex: 1,
  vehicleId: "v2",
  vehicleName: "Tesla Model 3",
  vehiclePowertrain: "bev",
  occupancy: 1,
  energy: {
    fuelLiters: null,
    electricityKwh: 16.4,
    provenance: {
      kind: "calculated",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "Tesla Model 3 (160 Wh/km)",
      assumptions: [{ kind: "charging_efficiency", percent: 90 }],
    },
  },
  emissions: {
    totalGrams: 2400,
    tailpipeGrams: 0,
    upstreamGrams: 2400,
    provenance: {
      kind: "defaulted",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "EEA 2024 / Eurostat 2026",
      assumptions: [{ kind: "grid_intensity", gramsPerKwh: 230 }],
    },
  },
  cost: {
    costType: "road",
    currency: "EUR",
    energyCost: 6.8,
    tollStatus: "tolls_unknown",
    tollCost: null,
    transitFare: null,
    knownCost: 6.8,
    totalCost: null,
    costCompleteness: "partial",
    energyCostProvenance: {
      kind: "defaulted",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "Eurostat 2026",
      assumptions: [{ kind: "unit_price", value: 0.36, currency: "EUR" }],
    },
  },
  comparison: {
    isLowestEmissions: false,
    isLowestCost: false,
    isFastest: false,
    emissionsDeltaGrams: 0,
    emissionsDeltaPct: 0,
    costDelta: 0,
    reason: null,
  },
};

function renderBadge(
  props: Partial<React.ComponentProps<typeof RouteImpactBadge>> & {
    impact: RouteImpact;
    locale?: string;
    messages?: Record<string, unknown>;
  },
) {
  const { impact, locale = "en", messages = en, ...rest } = props;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <RouteImpactBadge impact={impact} {...rest} />
    </NextIntlClientProvider>,
  );
}

describe("formatImpactCost", () => {
  it("formats total cost when known", () => {
    const cost: RouteImpact["cost"] = {
      costType: "road",
      currency: "EUR",
      energyCost: 6.8,
      tollStatus: "no_tolls",
      tollCost: null,
      transitFare: null,
      knownCost: 6.8,
      totalCost: 6.8,
      costCompleteness: "complete",
      energyCostProvenance: mockDieselImpact.cost.energyCostProvenance,
    };
    expect(formatImpactCost(cost, "en")).toContain("6.80");
  });

  it("formats a known road subtotal without claiming that tolls apply", () => {
    const cost: RouteImpact["cost"] = {
      costType: "road",
      currency: "EUR",
      energyCost: 6.8,
      tollStatus: "unknown",
      tollCost: null,
      transitFare: null,
      knownCost: 6.8,
      totalCost: null,
      costCompleteness: "partial",
      energyCostProvenance: mockDieselImpact.cost.energyCostProvenance,
    };
    const formatted = formatImpactCost(cost, "en", {
      tollCoverageUnknown: "Toll cost unknown",
      tollAmountUnknown: "Tolls apply; amount unknown",
      fareUnavailable: "Fare unavailable",
      costUnavailable: "Cost unavailable",
    });
    expect(formatted).toContain("6.80");
    expect(formatted).toContain("Toll cost unknown");
    expect(formatted).not.toContain("+");
  });

  it("does not render unknown transit fare as tolls", () => {
    const cost: RouteImpact["cost"] = {
      costType: "transit",
      currency: "EUR",
      energyCost: 0,
      tollStatus: "no_tolls",
      tollCost: null,
      transitFare: null,
      knownCost: null,
      totalCost: null,
      costCompleteness: "unavailable",
      energyCostProvenance: mockDieselImpact.cost.energyCostProvenance,
    };
    const formatted = formatImpactCost(cost, "en", {
      tollCoverageUnknown: "Toll cost unknown",
      tollAmountUnknown: "Tolls apply; amount unknown",
      fareUnavailable: "Fare unavailable",
      costUnavailable: "Cost unavailable",
    });
    expect(formatted).toBe("Fare unavailable");
    expect(formatted).not.toContain("Toll");
  });
});

describe("RouteImpactBadge", () => {
  it("renders cost and CO2 summary text", () => {
    renderBadge({ impact: mockDieselImpact });
    const textEl = screen.getByTestId("impact-summary-text");
    expect(textEl.textContent).toContain("6.80");
    expect(textEl.textContent).toContain("8.4 kg CO2");
  });

  it("renders Eco Choice badge when isLowestEmissions is true", () => {
    renderBadge({ impact: mockDieselImpact });
    const ecoChip = screen.getByTestId("eco-choice-chip");
    expect(ecoChip).toBeInTheDocument();
    expect(ecoChip.textContent).toBe("Eco Choice");
  });

  it("does not render Eco Choice badge when isLowestEmissions is false", () => {
    renderBadge({ impact: mockEvImpactTollsUnknown });
    expect(screen.queryByTestId("eco-choice-chip")).toBeNull();
  });

  it("calls onClick when clicked", () => {
    const handleClick = vi.fn();
    renderBadge({ impact: mockDieselImpact, onClick: handleClick });

    const badge = screen.getByTestId("route-impact-badge");
    fireEvent.click(badge);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("activates onClick via keyboard (Enter and Space)", async () => {
    const handleClick = vi.fn();
    renderBadge({ impact: mockDieselImpact, onClick: handleClick });

    const badge = screen.getByTestId("route-impact-badge");
    badge.focus();
    await userEvent.keyboard("{Enter}");
    expect(handleClick).toHaveBeenCalledTimes(1);

    await userEvent.keyboard(" ");
    expect(handleClick).toHaveBeenCalledTimes(2);
  });

  it("renders non-button div when onClick is not provided", () => {
    renderBadge({ impact: mockDieselImpact, onClick: undefined });
    const badge = screen.getByTestId("route-impact-badge");
    expect(badge.tagName.toLowerCase()).toBe("div");
  });

  it("provides minimum 48px touch target on interactive element", () => {
    renderBadge({ impact: mockDieselImpact, onClick: vi.fn() });
    const badge = screen.getByTestId("route-impact-badge");
    // ButtonBase element has minHeight: 48 and minWidth: 48
    expect(badge.tagName.toLowerCase()).toBe("button");
  });

  it("renders German localized text and eco label", () => {
    renderBadge({
      impact: mockDieselImpact,
      locale: "de",
      messages: de,
    });
    expect(screen.getByTestId("eco-choice-chip").textContent).toBe("Öko-Tipp");
    expect(screen.getByTestId("impact-summary-text").textContent).toContain("8,4 kg CO2");
  });
});
