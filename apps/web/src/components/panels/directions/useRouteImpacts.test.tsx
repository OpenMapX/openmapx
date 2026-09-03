// @vitest-environment jsdom

import type { PersonalVehicle, Route } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useCountryFromCoordinatesSpy = vi.fn();
const useAmbientFuelPricesSpy = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useCountryFromCoordinates: (...args: unknown[]) => useCountryFromCoordinatesSpy(...args),
  };
});

vi.mock("@/lib/fuel/useAmbientFuelPrices", () => ({
  useAmbientFuelPrices: (...args: unknown[]) => useAmbientFuelPricesSpy(...args),
}));

import { useRouteImpacts } from "./useRouteImpacts";

const route: Route = {
  distance: 10_000,
  duration: 900,
  geometry: [
    [13.3, 52.4],
    [13.4, 52.5],
  ],
  legs: [],
  steps: [],
  mode: "driving",
};

const petrolVehicle: PersonalVehicle = {
  id: "petrol",
  name: "Petrol car",
  kind: "car",
  powertrain: "petrol",
  isDefault: true,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6.5,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const electricVehicle: PersonalVehicle = {
  ...petrolVehicle,
  id: "electric",
  name: "Electric car",
  powertrain: "electric",
  fuelConsumptionLPer100Km: null,
  ev: {
    batteryKwh: 60,
    baseWhPerKm: 180,
    massTonnes: 1.8,
    maxDcKw: 150,
    maxAcKw: 11,
    vehicleTaperSocPct: 80,
    connectors: ["ccs2"],
  },
};

const bicycle: PersonalVehicle = {
  ...petrolVehicle,
  id: "bicycle",
  name: "Bicycle",
  kind: "bicycle",
  powertrain: "other",
  fuelConsumptionLPer100Km: null,
};

const motorcycle: PersonalVehicle = {
  ...petrolVehicle,
  id: "motorcycle",
  name: "Motorcycle",
  kind: "motorcycle",
  fuelConsumptionLPer100Km: 4,
  isDefault: false,
};

const pluginHybrid: PersonalVehicle = {
  ...electricVehicle,
  id: "plugin-hybrid",
  name: "Plug-in hybrid",
  powertrain: "plugin_hybrid",
  isDefault: true,
};

const destination: [number, number] = [13.4, 52.5];

describe("useRouteImpacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCountryFromCoordinatesSpy.mockReturnValue({ data: "DE" });
    useAmbientFuelPricesSpy.mockReturnValue({
      prices: {
        petrol: {
          fuelGrade: "e10",
          pricePerLiter: 1.7,
          currency: "EUR",
          sampleCount: 3,
          provenance: {
            kind: "provider",
            timestamp: "2026-09-03T12:00:00Z",
            citation: "National fuel feed",
            assumptions: [],
          },
        },
        diesel: {
          fuelGrade: "diesel",
          pricePerLiter: 1.6,
          currency: "EUR",
          sampleCount: 2,
          provenance: {
            kind: "provider",
            timestamp: "2026-09-03T12:00:00Z",
            citation: "National fuel feed",
            assumptions: [],
          },
        },
      },
      isLoading: false,
    });
  });

  it("uses destination country and enables live pricing for fuel vehicles", () => {
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [petrolVehicle],
        homeElectricityPrice: null,
        homeElectricityCurrency: "CHF",
      }),
    );

    expect(useCountryFromCoordinatesSpy).toHaveBeenCalledWith(destination, true);
    expect(useAmbientFuelPricesSpy).toHaveBeenCalledWith(destination, true);
    expect(result.current.impacts[0].cost.currency).toBe("EUR");
    expect(result.current.impacts[0].cost.energyCost).toBeCloseTo(0.65 * 1.7, 3);
    expect(result.current.impacts[0].cost.energyCostProvenance.kind).toBe("provider");
  });

  it("enables live pricing outside Germany and lets the provider decide coverage", () => {
    useCountryFromCoordinatesSpy.mockReturnValue({ data: "FR" });

    renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [petrolVehicle],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    expect(useAmbientFuelPricesSpy).toHaveBeenCalledWith(destination, true);
  });

  it("does not query fuel prices for an EV and applies the home tariff currency", () => {
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [electricVehicle],
        homeElectricityPrice: 0.25,
        homeElectricityCurrency: "CHF",
      }),
    );

    expect(useAmbientFuelPricesSpy).toHaveBeenCalledWith(destination, false);
    expect(result.current.impacts[0].cost.currency).toBe("CHF");
    expect(result.current.impacts[0].cost.energyCostProvenance.kind).toBe("user_override");
  });

  it("keeps user assumptions across recalculations", () => {
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [petrolVehicle],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    act(() => result.current.updateAssumptions({ occupancy: 3, fuelPricePerLiter: 2 }));

    expect(result.current.impacts[0].occupancy).toBe(3);
    expect(result.current.impacts[0].cost.energyCost).toBeCloseTo(0.65 * 2, 3);
    expect(result.current.impacts[0].cost.energyCostProvenance.kind).toBe("user_override");
  });

  it("ignores an incompatible default bicycle for a driving route", () => {
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [
          { ...bicycle, isDefault: true },
          { ...petrolVehicle, isDefault: false },
        ],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    expect(result.current.impacts[0].vehicleId).toBe("petrol");
    expect(result.current.impacts[0].energy.fuelLiters).toBeGreaterThan(0);
  });

  it("selects a motorcycle only for motorcycle routes", () => {
    const motorcycleRoute = { ...route, mode: "motorcycle" as const };
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [motorcycleRoute],
        destination,
        vehicles: [petrolVehicle, motorcycle],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    expect(result.current.impacts[0].vehicleId).toBe("motorcycle");
  });

  it("suppresses meaningless impact badges for active travel", () => {
    const walkingRoute = { ...route, mode: "walking" as const };
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [walkingRoute],
        destination,
        vehicles: [petrolVehicle],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    expect(result.current.impacts).toEqual([]);
    expect(result.current.compatibleVehicles).toEqual([]);
  });

  it("exposes only vehicles compatible with the route mode", () => {
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [bicycle, motorcycle, petrolVehicle],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    expect(result.current.compatibleVehicles).toEqual([petrolVehicle]);
  });

  it("reports plug-in hybrid estimates as unavailable instead of inventing consumption", () => {
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [pluginHybrid],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    expect(result.current.impacts).toEqual([]);
    expect(result.current.unavailableReason).toBe("plugin_hybrid_inputs_missing");
  });

  it("reports an unknown motorized powertrain as unsupported", () => {
    const { result } = renderHook(() =>
      useRouteImpacts({
        routes: [route],
        destination,
        vehicles: [{ ...petrolVehicle, powertrain: "other" }],
        homeElectricityPrice: null,
        homeElectricityCurrency: "EUR",
      }),
    );

    expect(result.current.impacts).toEqual([]);
    expect(result.current.unavailableReason).toBe("unsupported_powertrain");
  });
});
