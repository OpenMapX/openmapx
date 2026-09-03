import type { RouteImpact } from "@openmapx/core";
import { de, en } from "@openmapx/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEnergyConsumed, RouteImpactDetailsDialog } from "./RouteImpactDetailsDialog";

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
      citation: "GLEC Framework v3",
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
      sourceUrl: "https://creativecommons.tankerkoenig.de/",
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

const mockEvImpactMultiOccupancy: RouteImpact = {
  routeIndex: 1,
  vehicleId: "v2",
  vehicleName: "Tesla Model 3",
  vehiclePowertrain: "bev",
  occupancy: 3,
  perPerson: {
    emissionsGrams: 800,
    knownCost: 1.4,
    totalCost: null,
  },
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
    energyCost: 4.2,
    tollStatus: "tolls_unknown",
    tollCost: null,
    transitFare: null,
    knownCost: 4.2,
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

function renderDialog(
  props: Partial<React.ComponentProps<typeof RouteImpactDetailsDialog>> & {
    impact: RouteImpact;
    locale?: string;
    messages?: Record<string, unknown>;
  },
) {
  const { impact, locale = "en", messages = en, open = true, onClose = vi.fn(), ...rest } = props;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <RouteImpactDetailsDialog impact={impact} open={open} onClose={onClose} {...rest} />
    </NextIntlClientProvider>,
  );
}

describe("formatEnergyConsumed", () => {
  it("formats diesel fuel liters", () => {
    expect(
      formatEnergyConsumed(
        { fuelLiters: 4.2, electricityKwh: null, provenance: mockDieselImpact.energy.provenance },
        "diesel",
        "en",
      ),
    ).toBe("4.2 L Diesel");
  });

  it("formats petrol fuel liters with localized label", () => {
    expect(
      formatEnergyConsumed(
        { fuelLiters: 5.1, electricityKwh: null, provenance: mockDieselImpact.energy.provenance },
        "petrol",
        "de",
        "Benzin",
        "Strom",
      ),
    ).toBe("5,1 L Benzin");
  });

  it("formats electricity kWh with localized label", () => {
    expect(
      formatEnergyConsumed(
        { fuelLiters: null, electricityKwh: 16.4, provenance: mockDieselImpact.energy.provenance },
        "bev",
        "de",
        "Benzin",
        "Strom",
      ),
    ).toBe("16,4 kWh Strom");
  });

  it("returns dash when energy is null", () => {
    expect(
      formatEnergyConsumed(
        { fuelLiters: null, electricityKwh: null, provenance: mockDieselImpact.energy.provenance },
        "bicycle",
        "en",
      ),
    ).toBe("—");
  });
});

describe("RouteImpactDetailsDialog", () => {
  describe("Breakdown Section", () => {
    it("renders dialog with title and vehicle name", () => {
      renderDialog({ impact: mockDieselImpact });
      expect(screen.getByTestId("dialog-vehicle-name").textContent).toBe("VW Golf 2.0 TDI");
      expect(screen.getByTestId("breakdown-tab-content")).toBeInTheDocument();
    });

    it("displays the well-to-wheel emissions breakdown for ICE diesel", () => {
      renderDialog({ impact: mockDieselImpact });
      expect(screen.getByTestId("wtw-total-emissions").textContent).toContain("8.4 kg CO2");
      expect(screen.getByTestId("tailpipe-emissions").textContent).toContain("7 kg CO2");
      expect(screen.getByTestId("upstream-emissions").textContent).toContain("1.4 kg CO2");
    });

    it("displays the emissions breakdown for EV with zero direct tailpipe note", () => {
      renderDialog({ impact: mockEvImpactMultiOccupancy });
      expect(screen.getByTestId("wtw-total-emissions").textContent).toContain("2.4 kg CO2");
      expect(screen.getByTestId("tailpipe-emissions").textContent).toContain(
        "0 g (Zero direct emissions)",
      );
      expect(screen.getByTestId("upstream-emissions").textContent).toContain("2.4 kg CO2");
    });

    it("displays energy consumed", () => {
      renderDialog({ impact: mockEvImpactMultiOccupancy });
      expect(screen.getByTestId("energy-consumed-value").textContent).toContain(
        "16.4 kWh Electric",
      );
    });

    it("displays a known subtotal with unknown toll coverage", () => {
      renderDialog({ impact: mockDieselImpact });
      expect(screen.getByTestId("energy-cost-value").textContent).toContain("6.80");
      expect(screen.getByTestId("tolls-cost-value").textContent).toContain("Toll cost unknown");
      expect(screen.getByTestId("total-cost-value").textContent).toContain("6.80");
      expect(screen.getByText("Known subtotal")).toBeInTheDocument();
    });

    it("displays monetary cost breakdown with unknown tolls", () => {
      renderDialog({ impact: mockEvImpactMultiOccupancy });
      expect(screen.getByTestId("energy-cost-value").textContent).toContain("4.20");
      expect(screen.getByTestId("tolls-cost-value").textContent).toContain(
        "Tolls apply (amount unknown)",
      );
      expect(screen.getByTestId("total-cost-value").textContent).toContain("4.20");
      expect(screen.getByTestId("total-cost-value").textContent).not.toContain("+");
    });

    it("does not show per-person breakdown when occupancy is 1", () => {
      renderDialog({ impact: mockDieselImpact });
      expect(screen.queryByTestId("per-person-section")).toBeNull();
    });

    it("shows per-person breakdown when occupancy > 1", () => {
      renderDialog({ impact: mockEvImpactMultiOccupancy });
      expect(screen.getByTestId("per-person-section")).toBeInTheDocument();
      expect(screen.getByTestId("per-person-emissions").textContent).toContain("800 g CO2");
      expect(screen.getByTestId("per-person-cost").textContent).toContain("1.40");
      expect(screen.getAllByText("Known subtotal").length).toBeGreaterThan(0);
    });

    it("displays comparison banner with explanation and Eco Choice chip", () => {
      renderDialog({ impact: mockDieselImpact });
      expect(screen.getByTestId("comparison-explanation-banner")).toBeInTheDocument();
      expect(screen.getByText("Saves 3.2 km distance")).toBeInTheDocument();
      expect(screen.getByTestId("dialog-eco-choice-chip")).toBeInTheDocument();
    });
  });

  describe("Assumptions Section", () => {
    it("updates occupancy through the assumptions callback", () => {
      const handleAssumptions = vi.fn();
      renderDialog({
        impact: mockDieselImpact,
        onUpdateAssumptions: handleAssumptions,
      });

      fireEvent.click(screen.getByTestId("tab-assumptions"));
      expect(screen.getByTestId("assumptions-tab-content")).toBeInTheDocument();

      const sliderInput = screen
        .getByTestId("occupancy-slider")
        .querySelector('input[type="range"]');
      expect(sliderInput).not.toBeNull();
      if (sliderInput) {
        fireEvent.change(sliderInput, { target: { value: "4" } });
        expect(handleAssumptions).toHaveBeenCalledWith({ occupancy: 4 });
      }
    });

    it("only renders fuel price input for vehicle using fuel, not electricity input", () => {
      const handleAssumptions = vi.fn();
      renderDialog({
        impact: mockDieselImpact,
        onUpdateAssumptions: handleAssumptions,
      });

      fireEvent.click(screen.getByTestId("tab-assumptions"));
      expect(screen.getByTestId("fuel-price-input")).toBeInTheDocument();
      expect(screen.queryByTestId("electricity-price-input")).toBeNull();

      const input = screen.getByTestId("fuel-price-input").querySelector("input");
      expect(input).not.toBeNull();
      if (input) {
        fireEvent.change(input, { target: { value: "1.75" } });
        expect(handleAssumptions).toHaveBeenCalledWith({ fuelPricePerLiter: 1.75 });
      }
    });

    it("only renders electricity price input for BEV, not fuel input", () => {
      const handleAssumptions = vi.fn();
      renderDialog({
        impact: mockEvImpactMultiOccupancy,
        onUpdateAssumptions: handleAssumptions,
      });

      fireEvent.click(screen.getByTestId("tab-assumptions"));
      expect(screen.getByTestId("electricity-price-input")).toBeInTheDocument();
      expect(screen.queryByTestId("fuel-price-input")).toBeNull();

      const input = screen.getByTestId("electricity-price-input").querySelector("input");
      expect(input).not.toBeNull();
      if (input) {
        fireEvent.change(input, { target: { value: "0.40" } });
        expect(handleAssumptions).toHaveBeenCalledWith({ electricityPricePerKwh: 0.4 });
      }
    });

    it("allows selecting vehicle from Select dropdown", () => {
      const handleAssumptions = vi.fn();
      const vehicles = [
        { id: "v1", name: "VW Golf TDI" },
        { id: "v2", name: "Tesla Model 3" },
      ];
      renderDialog({
        impact: mockDieselImpact,
        vehicles,
        onUpdateAssumptions: handleAssumptions,
      });

      fireEvent.click(screen.getByTestId("tab-assumptions"));
      expect(screen.getByTestId("vehicle-select")).toBeInTheDocument();
    });
  });

  describe("Provenance Section", () => {
    it("displays fuel price citation, formatted date, and assumptions", () => {
      renderDialog({ impact: mockDieselImpact });

      fireEvent.click(screen.getByTestId("tab-provenance"));
      expect(screen.getByTestId("provenance-tab-content")).toBeInTheDocument();

      expect(screen.getByTestId("fuel-provenance-citation").textContent).toContain(
        "Tankerkönig DE",
      );
      expect(screen.getByTestId("fuel-provenance-timestamp")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Tankerkönig DE/ })).toHaveAttribute(
        "href",
        "https://creativecommons.tankerkoenig.de/",
      );
      expect(screen.getByText("Unit price: 1.62 EUR")).toBeInTheDocument();
    });

    it("labels combustion provenance as emission factors rather than grid intensity", () => {
      renderDialog({ impact: mockDieselImpact });

      fireEvent.click(screen.getByTestId("tab-provenance"));
      expect(screen.getByText("Emission factors")).toBeInTheDocument();
      expect(screen.getByTestId("emissions-provenance-citation").textContent).toContain(
        "GLEC Framework v3",
      );
      expect(screen.getByText("Tailpipe factor: 2,640 g CO2e/L")).toBeInTheDocument();
    });

    it("does not expose an unsafe provenance URL", () => {
      renderDialog({
        impact: {
          ...mockDieselImpact,
          cost: {
            ...mockDieselImpact.cost,
            energyCostProvenance: {
              ...mockDieselImpact.cost.energyCostProvenance,
              sourceUrl: "javascript:alert(1)",
            },
          },
        },
      });

      fireEvent.click(screen.getByTestId("tab-provenance"));
      expect(screen.getByTestId("fuel-provenance-citation").querySelector("a")).not.toHaveAttribute(
        "href",
      );
    });
  });

  describe("German Localization", () => {
    it("renders German labels, zero emissions string, and number formatting", () => {
      renderDialog({
        impact: mockEvImpactMultiOccupancy,
        locale: "de",
        messages: de,
      });

      expect(screen.getByText("Routen-Auswirkungen")).toBeInTheDocument();
      expect(screen.getByTestId("wtw-total-emissions").textContent).toContain("2,4 kg CO2");
      expect(screen.getByTestId("tailpipe-emissions").textContent).toContain(
        "0 g (Keine direkten Emissionen)",
      );
      expect(screen.getByTestId("total-cost-value").textContent).toContain("4,20");
      expect(screen.getByTestId("total-cost-value").textContent).not.toContain("+");

      fireEvent.click(screen.getByTestId("tab-provenance"));
      expect(screen.getByText("Ladewirkungsgrad: 90%")).toBeInTheDocument();
    });
  });
});
