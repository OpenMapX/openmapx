import { describe, expect, it } from "vitest";
import type { Route, RouteStep } from "../types/routing";
import type { PersonalVehicle } from "../vehicles/types";
import { calculateRouteImpact, compareRouteAlternatives, tempDerate } from "./calculate";

function makeRoute(options: {
  distance?: number;
  duration?: number;
  mode?: "driving" | "walking" | "cycling" | "transit" | "motorcycle";
  elevation?: number[];
  elevationInterval?: number;
  steps?: RouteStep[];
  co2Grams?: number;
}): Route {
  const distance = options.distance ?? 50_000; // 50 km default
  return {
    distance,
    duration: options.duration ?? 1800,
    geometry: [
      [10.0, 50.0],
      [10.5, 50.5],
    ],
    legs: [
      {
        distance,
        duration: options.duration ?? 1800,
        geometry: [
          [10.0, 50.0],
          [10.5, 50.5],
        ],
        steps: options.steps ?? [],
      },
    ],
    steps: options.steps ?? [],
    mode: options.mode ?? "driving",
    elevation: options.elevation,
    elevationInterval: options.elevationInterval,
    ...(options.co2Grams !== undefined ? { co2Grams: options.co2Grams } : {}),
  } as Route;
}

const evCar: PersonalVehicle = {
  id: "veh-ev-1",
  name: "Tesla Model 3",
  kind: "car",
  powertrain: "electric",
  isDefault: true,
  presetId: "tesla-model-3",
  ev: {
    batteryKwh: 60,
    baseWhPerKm: 150,
    massTonnes: 1.8,
    maxDcKw: 170,
    maxAcKw: 11,
    vehicleTaperSocPct: 80,
    connectors: ["ccs2"],
  },
  fuelConsumptionLPer100Km: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const petrolCar: PersonalVehicle = {
  id: "veh-petrol-1",
  name: "VW Golf TSI",
  kind: "car",
  powertrain: "petrol",
  isDefault: false,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6.5,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const dieselCar: PersonalVehicle = {
  id: "veh-diesel-1",
  name: "BMW 320d",
  kind: "car",
  powertrain: "diesel",
  isDefault: false,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 5.4,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const hybridCar: PersonalVehicle = {
  id: "veh-hybrid-1",
  name: "Toyota Prius",
  kind: "car",
  powertrain: "hybrid",
  isDefault: false,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 4.4,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const pluginHybridCar: PersonalVehicle = {
  ...evCar,
  id: "veh-phev-1",
  name: "Plug-in hybrid",
  powertrain: "plugin_hybrid",
  fuelConsumptionLPer100Km: null,
};

const bicycle: PersonalVehicle = {
  id: "veh-bike-1",
  name: "City bike",
  kind: "bicycle",
  powertrain: "other",
  isDefault: false,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const unsupportedCar: PersonalVehicle = {
  ...petrolCar,
  id: "veh-other-1",
  name: "Unknown drivetrain",
  powertrain: "other",
  fuelConsumptionLPer100Km: null,
};

describe("calculateRouteImpact", () => {
  describe("vehicle and route compatibility", () => {
    it("rejects a bicycle supplied for a driving route instead of returning zero impact", () => {
      expect(() => calculateRouteImpact(makeRoute({ mode: "driving" }), bicycle)).toThrow(
        /not compatible/i,
      );
    });

    it("rejects an unknown motorized powertrain instead of assuming petrol", () => {
      expect(() => calculateRouteImpact(makeRoute({ mode: "driving" }), unsupportedCar)).toThrow(
        /unsupported powertrain/i,
      );
    });

    it("rejects plug-in hybrids until a charge-depleting model is available", () => {
      expect(() => calculateRouteImpact(makeRoute({ mode: "driving" }), pluginHybridCar)).toThrow(
        /plug-in hybrid/i,
      );
    });

    it("uses motorcycle fallback consumption when no garage motorcycle exists", () => {
      const impact = calculateRouteImpact(
        makeRoute({ mode: "motorcycle", distance: 100_000 }),
        null,
      );

      expect(impact.vehicleName).toBe("Default Motorcycle");
      expect(impact.energy.fuelLiters).toBeCloseTo(4.2, 2);
    });

    it("does not attach an unrelated garage vehicle to active travel", () => {
      expect(() => calculateRouteImpact(makeRoute({ mode: "walking" }), petrolCar)).toThrow(
        /not compatible/i,
      );
    });
  });

  describe("default vehicle fallback (vehicle == null)", () => {
    it("uses Default Car petrol specifications (6.8 L/100km, 1.4t)", () => {
      const route = makeRoute({ distance: 100_000 }); // 100 km
      const impact = calculateRouteImpact(route, null, {
        countryCode: "DE",
      });

      expect(impact.vehicleId).toBeNull();
      expect(impact.vehicleName).toBe("Default Car");
      expect(impact.vehiclePowertrain).toBe("petrol");
      expect(impact.energy.electricityKwh).toBeNull();
      // 100 km * 6.8 L / 100 km = 6.8 L
      expect(impact.energy.fuelLiters).toBeCloseTo(6.8, 2);
      expect(impact.energy.provenance.kind).toBe("defaulted");

      // GLEC v3 European gasoline factors converted from g/MJ with
      // 42.5 MJ/kg lower heating value and 0.74 kg/L density.
      expect(impact.emissions.tailpipeGrams).toBeCloseTo(6.8 * 2361.895, 0);
      expect(impact.emissions.upstreamGrams).toBeCloseTo(6.8 * 754.8, 0);
      expect(impact.emissions.totalGrams).toBeCloseTo(6.8 * 3116.695, 0);
      expect(impact.emissions.provenance.kind).toBe("defaulted");
      expect(impact.emissions.provenance.sourceUrl).toContain("smartfreightcentre.org");
      expect(impact.emissions.totalGrams).toBeCloseTo(
        impact.emissions.tailpipeGrams + impact.emissions.upstreamGrams,
        1,
      );

      // Cost in DE: 6.8 L * 1.78 EUR/L = 12.104 EUR
      expect(impact.cost.currency).toBe("EUR");
      expect(impact.cost.energyCost).toBeCloseTo(6.8 * 1.78, 2);
      expect(impact.cost.knownCost).toBeCloseTo(6.8 * 1.78, 2);
      expect(impact.cost.totalCost).toBeNull();
      expect(impact.cost.costCompleteness).toBe("partial");
      expect(impact.cost.tollStatus).toBe("unknown");
    });
  });

  describe("Electric Vehicle (EV) physics & emissions", () => {
    it("computes flat route electric consumption and temperature derate", () => {
      // 100 km flat route at 20°C: 100 * 150 Wh/km = 15 kWh
      const route = makeRoute({ distance: 100_000 });
      const impact20C = calculateRouteImpact(route, evCar, {
        ambientTempC: 20,
        countryCode: "DE",
      });

      expect(impact20C.energy.fuelLiters).toBeNull();
      // Public energy is grid draw, so it includes charging losses.
      expect(impact20C.energy.electricityKwh).toBeCloseTo(15 / 0.9, 1);

      // DE grid carbon intensity: 380 g/kWh. Charging efficiency: 0.90.
      // Upstream = (15 / 0.90) * 380 ≈ 6,333.3 g.
      expect(impact20C.emissions.tailpipeGrams).toBe(0);
      expect(impact20C.emissions.upstreamGrams).toBeCloseTo((15 / 0.9) * 380, 1);
      expect(impact20C.emissions.totalGrams).toBeCloseTo(impact20C.emissions.upstreamGrams, 1);

      // DE household fallback: 0.3835 EUR/kWh, billed on wall energy.
      expect(impact20C.cost.energyCost).toBeCloseTo((15 / 0.9) * 0.3835, 2);

      // Cold weather test: -10°C
      // tempDerate(-10): d = -30 -> 1 + 0.012 * 30 = 1.36
      const impactCold = calculateRouteImpact(route, evCar, {
        ambientTempC: -10,
        countryCode: "DE",
      });
      expect(tempDerate(20)).toBe(1.0);
      expect(tempDerate(-10)).toBeCloseTo(1.36, 2);
      expect(impactCold.energy.electricityKwh).toBeCloseTo((15 * 1.36) / 0.9, 1);
    });

    it("integrates elevation climb and regenerative braking recovery (60%)", () => {
      // 10 km route with climb: 0 -> 500m
      // Distance energy: 10 km * 150 Wh/km = 1,500 Wh
      // Climb work: 500m * 2.725 Wh/m/tonne * 1.8 tonnes = 2,452.5 Wh
      // Total climb Wh = 1500 + 2452.5 = 3,952.5 Wh = 3.9525 kWh
      const climbRoute = makeRoute({
        distance: 10_000,
        elevation: [0, 500],
        elevationInterval: 10_000,
      });
      const climbImpact = calculateRouteImpact(climbRoute, evCar, { ambientTempC: 20 });
      expect(climbImpact.energy.electricityKwh).toBeCloseTo(3.9525 / 0.9, 2);

      // 10 km route with descent: 500m -> 0m
      // Distance energy: 1,500 Wh
      // Descent regen: -500m * 0.60 * 2.725 * 1.8 = -1,471.5 Wh
      // Total descent Wh = 1500 - 1471.5 = 28.5 Wh = 0.0285 kWh
      const descentRoute = makeRoute({
        distance: 10_000,
        elevation: [500, 0],
        elevationInterval: 10_000,
      });
      const descentImpact = calculateRouteImpact(descentRoute, evCar, { ambientTempC: 20 });
      expect(descentImpact.energy.electricityKwh).toBeCloseTo(0.0285 / 0.9, 2);
      expect(climbImpact.energy.electricityKwh ?? 0).toBeGreaterThan(
        descentImpact.energy.electricityKwh ?? 0,
      );

      // Round trip / hill with up and down: 0 -> 500m -> 0
      const hillRoute = makeRoute({
        distance: 20_000,
        elevation: [0, 500, 0],
        elevationInterval: 10_000,
      });
      const hillImpact = calculateRouteImpact(hillRoute, evCar, { ambientTempC: 20 });
      // Distance Wh = 20 * 150 = 3000 Wh.
      // Net elevation Wh = 2452.5 - 1471.5 = 981 Wh.
      // Total = 3981 Wh = 3.981 kWh.
      expect(hillImpact.energy.electricityKwh).toBeCloseTo(3.981 / 0.9, 2);
    });

    it("ignores sub-metre elevation jitter", () => {
      const flat = calculateRouteImpact(makeRoute({ distance: 10_000 }), evCar, {
        ambientTempC: 20,
      });
      const noisy = calculateRouteImpact(
        makeRoute({
          distance: 10_000,
          elevation: [100, 100.4, 99.8, 100.2, 99.9],
          elevationInterval: 2_500,
        }),
        evCar,
        { ambientTempC: 20 },
      );

      expect(noisy.energy.electricityKwh).toBe(flat.energy.electricityKwh);
    });
  });

  describe("Combustion engines (petrol, diesel, hybrid)", () => {
    it("does not double-count elevation on top of measured petrol consumption", () => {
      // 10 km flat route with petrol car (6.5 L/100km): base = 0.65 L
      const flatRoute = makeRoute({ distance: 10_000 });
      const flatImpact = calculateRouteImpact(flatRoute, petrolCar, { countryCode: "FR" });
      expect(flatImpact.energy.fuelLiters).toBeCloseTo(0.65, 3);

      const climbRoute = makeRoute({
        distance: 10_000,
        elevation: [0, 500],
        elevationInterval: 10_000,
      });
      const climbImpact = calculateRouteImpact(climbRoute, petrolCar, { countryCode: "FR" });
      expect(climbImpact.energy.fuelLiters).toBeCloseTo(0.65, 3);

      // Downhill coasting in gear: fuel cutoff applies (0 extra liters added)
      const descentRoute = makeRoute({
        distance: 10_000,
        elevation: [500, 0],
        elevationInterval: 10_000,
      });
      const descentImpact = calculateRouteImpact(descentRoute, petrolCar, { countryCode: "FR" });
      expect(descentImpact.energy.fuelLiters).toBeCloseTo(0.65, 3);
    });

    it("computes diesel efficiency with sourced GLEC emission factors", () => {
      // 100 km flat route with diesel car (5.4 L/100km): 5.4 L
      const route = makeRoute({ distance: 100_000 });
      const impact = calculateRouteImpact(route, dieselCar, { countryCode: "DE" });

      expect(impact.energy.fuelLiters).toBeCloseTo(5.4, 2);
      // GLEC v3 European diesel factors converted from g/MJ with
      // 42.8 MJ/kg lower heating value and 0.83 kg/L density.
      expect(impact.emissions.tailpipeGrams).toBeCloseTo(5.4 * 2632.3284, 0);
      expect(impact.emissions.upstreamGrams).toBeCloseTo(5.4 * 799.29, 0);
      expect(impact.emissions.totalGrams).toBeCloseTo(5.4 * 3431.6184, 0);

      const climbRoute = makeRoute({
        distance: 10_000,
        elevation: [0, 500],
        elevationInterval: 10_000,
      });
      const climbImpact = calculateRouteImpact(climbRoute, dieselCar, { countryCode: "DE" });
      expect(climbImpact.energy.fuelLiters).toBeCloseTo(0.54, 2);
    });

    it("uses configured hybrid consumption without an uncalibrated regeneration adjustment", () => {
      // Hill route: 10 km climb (500m) and descent (500m)
      const hillRoute = makeRoute({
        distance: 20_000,
        elevation: [0, 500, 0],
        elevationInterval: 10_000,
      });

      const petrolImpact = calculateRouteImpact(hillRoute, petrolCar);
      const hybridImpact = calculateRouteImpact(hillRoute, hybridCar);

      expect(hybridImpact.energy.fuelLiters).toBeCloseTo(0.88, 2);
      expect(petrolImpact.energy.fuelLiters).toBeCloseTo(1.3, 2);
      expect(petrolImpact.energy.fuelLiters ?? 0).toBeGreaterThan(
        hybridImpact.energy.fuelLiters ?? 0,
      );
    });
  });

  describe("Non-motorized and Transit modes", () => {
    it("returns zero emissions and zero cost for bicycle and walking", () => {
      const walkRoute = makeRoute({ distance: 5_000, mode: "walking" });
      const walkImpact = calculateRouteImpact(walkRoute, null);
      expect(walkImpact.emissions.totalGrams).toBe(0);
      expect(walkImpact.emissions.tailpipeGrams).toBe(0);
      expect(walkImpact.emissions.upstreamGrams).toBe(0);
      expect(walkImpact.energy.fuelLiters).toBeNull();
      expect(walkImpact.energy.electricityKwh).toBeNull();
      expect(walkImpact.cost.totalCost).toBe(0);

      const bikeVehicle: PersonalVehicle = {
        id: "veh-bike",
        name: "Gravel Bike",
        kind: "bicycle",
        powertrain: "other",
        isDefault: false,
        presetId: null,
        ev: null,
        fuelConsumptionLPer100Km: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const bikeImpact = calculateRouteImpact(
        makeRoute({ distance: 5_000, mode: "cycling" }),
        bikeVehicle,
      );
      expect(bikeImpact.emissions.totalGrams).toBe(0);
      expect(bikeImpact.cost.totalCost).toBe(0);
    });

    it("handles transit routes with fallback and provider emissions", () => {
      // Conservative fallback: 50 km * 101.51 g/p-km (2026 average local bus)
      const transitFallbackRoute = makeRoute({ distance: 50_000, mode: "transit" });
      const fallbackImpact = calculateRouteImpact(transitFallbackRoute, null, {
        transitFare: 4.5,
      });
      expect(fallbackImpact.emissions.totalGrams).toBeCloseTo(5075.5, 1);
      expect(fallbackImpact.emissions.upstreamGrams).toBeCloseTo(5075.5, 1);
      expect(fallbackImpact.emissions.provenance.kind).toBe("defaulted");
      expect(fallbackImpact.emissions.provenance.sourceUrl).toContain("gov.uk");
      expect(fallbackImpact.cost.transitFare).toBe(4.5);
      expect(fallbackImpact.cost.totalCost).toBe(4.5);

      // Provider-reported emissions
      const transitProviderRoute = makeRoute({
        distance: 50_000,
        mode: "transit",
        co2Grams: 850,
      });
      const providerImpact = calculateRouteImpact(transitProviderRoute, null);
      expect(providerImpact.emissions.totalGrams).toBe(850);
      expect(providerImpact.emissions.provenance.kind).toBe("provider");
      expect(providerImpact.cost.transitFare).toBeNull();
      expect(providerImpact.cost.totalCost).toBeNull(); // Fare unknown

      // Provider and fallback values are already per passenger. A car
      // occupancy preference must not divide public-transport figures again.
      const multiOccupancyImpact = calculateRouteImpact(transitProviderRoute, null, {
        occupancy: 4,
      });
      expect(multiOccupancyImpact.occupancy).toBe(1);
      expect(multiOccupancyImpact.perPerson).toBeUndefined();
      expect(multiOccupancyImpact.emissions.totalGrams).toBe(850);
    });

    it("preserves a valid zero transit fare", () => {
      const impact = calculateRouteImpact(makeRoute({ mode: "transit" }), null, {
        transitFare: 0,
      });

      expect(impact.cost.transitFare).toBe(0);
      expect(impact.cost.knownCost).toBe(0);
      expect(impact.cost.totalCost).toBe(0);
      expect(impact.cost.costCompleteness).toBe("complete");
    });
  });

  describe("Tolls and cost detection", () => {
    it("does not infer structured toll data from localized instruction text", () => {
      const tollStep: RouteStep = {
        instruction: "Enter toll road A1",
        distance: 10_000,
        duration: 300,
        coordinates: [
          [10.0, 50.0],
          [10.1, 50.1],
        ],
      };
      const routeWithToll = makeRoute({ distance: 20_000, steps: [tollStep] });
      const impact = calculateRouteImpact(routeWithToll, petrolCar);

      expect(impact.cost.tollStatus).toBe("unknown");
      expect(impact.cost.tollCost).toBeNull();
      expect(impact.cost.totalCost).toBeNull(); // Total unknown due to toll
    });

    it("keeps toll coverage unknown when the provider supplied no structured toll data", () => {
      const normalStep: RouteStep = {
        instruction: "Continue onto Main Street",
        distance: 20_000,
        duration: 600,
        coordinates: [
          [10.0, 50.0],
          [10.1, 50.1],
        ],
      };
      const routeNoToll = makeRoute({ distance: 20_000, steps: [normalStep] });
      const impact = calculateRouteImpact(routeNoToll, petrolCar);

      expect(impact.cost.tollStatus).toBe("unknown");
      expect(impact.cost.totalCost).toBeNull();
      expect(impact.cost.knownCost).toBe(impact.cost.energyCost);
      expect(impact.cost.costCompleteness).toBe("partial");
      expect(impact.cost.energyCost).toBeGreaterThan(0);
    });
  });

  describe("Occupancy divisor", () => {
    it("divides total emissions and costs across multiple passengers", () => {
      const route = makeRoute({ distance: 100_000 });
      const impact1 = calculateRouteImpact(route, petrolCar, { occupancy: 1 });
      expect(impact1.occupancy).toBe(1);
      expect(impact1.perPerson).toBeUndefined();

      const impact3 = calculateRouteImpact(route, petrolCar, { occupancy: 3 });
      expect(impact3.occupancy).toBe(3);
      expect(impact3.perPerson).toBeDefined();
      expect(impact3.perPerson?.emissionsGrams).toBeCloseTo(impact3.emissions.totalGrams / 3, 2);
      expect(impact3.perPerson?.knownCost).toBeCloseTo((impact3.cost.knownCost ?? 0) / 3, 2);
      expect(impact3.perPerson?.totalCost).toBeNull();
    });
  });

  describe("User price overrides and provenance", () => {
    it("does not relabel fallback prices as an unrelated requested currency", () => {
      const fallback = calculateRouteImpact(makeRoute({}), petrolCar, {
        countryCode: "JP",
        currency: "CHF",
      });
      expect(fallback.cost.currency).toBe("EUR");

      const explicit = calculateRouteImpact(makeRoute({}), petrolCar, {
        countryCode: "JP",
        currency: "CHF",
        fuelPricePerLiter: 2,
      });
      expect(explicit.cost.currency).toBe("CHF");
    });

    it("rejects an invalid explicit currency code", () => {
      const impact = calculateRouteImpact(makeRoute({}), petrolCar, {
        countryCode: "DE",
        currency: "ZZZ",
        fuelPricePerLiter: 1.7,
      });

      expect(impact.cost.currency).toBe("EUR");
    });

    it("respects user fuel and electricity price overrides with user_override provenance", () => {
      const route = makeRoute({ distance: 100_000 });
      const petrolImpact = calculateRouteImpact(route, petrolCar, {
        fuelPricePerLiter: 2.15,
        fuelPriceSource: "My Favorite Station",
      });
      expect(petrolImpact.cost.energyCostProvenance.kind).toBe("user_override");
      expect(petrolImpact.cost.energyCostProvenance.citation).toBe("My Favorite Station");
      // 6.5 L * 2.15 = 13.975
      expect(petrolImpact.cost.energyCost).toBeCloseTo(13.975, 2);

      const evImpact = calculateRouteImpact(route, evCar, {
        electricityPricePerKwh: 0.45,
        electricityPriceSource: "Home Solar Tariff",
      });
      expect(evImpact.cost.energyCostProvenance.kind).toBe("user_override");
      expect(evImpact.cost.energyCostProvenance.citation).toBe("Home Solar Tariff");
      // (15 kWh / 0.90) * 0.45 = 7.50 (wall energy billed)
      expect(evImpact.cost.energyCost).toBeCloseTo(7.5, 2);
    });

    it("does not attach override provenance to an invalid price", () => {
      const route = makeRoute({ distance: 100_000 });
      const impact = calculateRouteImpact(route, petrolCar, {
        fuelPricePerLiter: -1,
        fuelPriceSource: "Invalid provider response",
        fuelPriceProvenanceKind: "provider",
        countryCode: "DE",
      });

      expect(impact.cost.energyCostProvenance.kind).toBe("defaulted");
      expect(impact.cost.energyCostProvenance.citation).not.toBe("Invalid provider response");
      expect(impact.cost.energyCost).toBeCloseTo(6.5 * 1.78, 2);
    });

    it("separates calculation time from provider observation time", () => {
      const calculatedAt = "2026-09-03T15:00:00Z";
      const observedAt = "2026-09-03T11:00:00Z";
      const impact = calculateRouteImpact(makeRoute({ distance: 10_000 }), petrolCar, {
        calculatedAt,
        fuelPricePerLiter: 1.7,
        fuelPriceSource: "prix-carburants.gouv.fr",
        fuelPriceTimestamp: observedAt,
      });

      expect(impact.cost.energyCostProvenance.calculatedAt).toBe(calculatedAt);
      expect(impact.cost.energyCostProvenance.timestamp).toBe(observedAt);
    });

    it("uses a benchmark effective date instead of calculation time for static inputs", () => {
      const calculatedAt = "2026-09-03T15:00:00Z";
      const impact = calculateRouteImpact(makeRoute({ distance: 10_000 }), petrolCar, {
        calculatedAt,
        countryCode: "DE",
      });

      expect(impact.cost.energyCostProvenance.calculatedAt).toBe(calculatedAt);
      expect(impact.cost.energyCostProvenance.timestamp).not.toBe(calculatedAt);
    });
  });
});

describe("compareRouteAlternatives (Eco Choice quality gate)", () => {
  it("marks isLowestEmissions: true with natural explanation when alternative saves >= 5%", () => {
    // Route 0: Fastest, 50 km, flat -> 50 km * 6.5 L/100km = 3.25 L
    // Total emissions use the shared GLEC petrol well-to-wheel factor.
    const fastestRoute = makeRoute({ distance: 50_000, duration: 1800 });

    // Route 1: Alternative, 45 km, saves 5.0 km (10% reduction >= 5%)
    // Since the factor is the same, the 10% fuel reduction is also a 10% emissions reduction.
    const ecoRoute = makeRoute({ distance: 45_000, duration: 2000 });

    const impacts = compareRouteAlternatives([fastestRoute, ecoRoute], petrolCar);

    expect(impacts).toHaveLength(2);
    // Fastest route
    expect(impacts[0].comparison?.isFastest).toBe(true);
    expect(impacts[0].comparison?.isLowestEmissions).toBe(false);
    expect(impacts[0].comparison?.emissionsDeltaGrams).toBe(0);
    expect(impacts[0].comparison?.emissionsDeltaPct).toBe(0);

    // Eco route (saves 10% >= 5%)
    expect(impacts[1].comparison?.isFastest).toBe(false);
    expect(impacts[1].comparison?.isLowestEmissions).toBe(true);
    expect(impacts[1].comparison?.emissionsDeltaPct).toBeCloseTo(-10, 1);
    expect(impacts[1].comparison?.emissionsDeltaGrams).toBeCloseTo(-1012.925875, 1);
    expect(impacts[1].comparison?.reason).toEqual({ kind: "shorter", distanceMeters: 5000 });
  });

  it("suppresses Eco Choice badge (isLowestEmissions: false) when alternative savings < 5%", () => {
    // Route 0: 50 km at the same consumption and emissions factor.
    const fastestRoute = makeRoute({ distance: 50_000, duration: 1800 });

    // Route 1 is 2% shorter, below the 5% recommendation threshold.
    const marginalRoute = makeRoute({ distance: 49_000, duration: 1900 });

    const impacts = compareRouteAlternatives([fastestRoute, marginalRoute], petrolCar);

    expect(impacts).toHaveLength(2);
    // Marginal route does NOT get the badge
    expect(impacts[1].comparison?.isLowestEmissions).toBe(false);
    expect(impacts[1].comparison?.reason).toBeNull();
  });

  it("generates elevation explanation for an EV when emissions are saved by avoiding climb", () => {
    // Route 0: 20 km with 300 m climb
    const mountainRoute = makeRoute({
      distance: 20_000,
      duration: 1200,
      elevation: [0, 300],
      elevationInterval: 10_000,
    });

    // Route 1: 20 km flat (avoids 300 m climb)
    const flatAlternative = makeRoute({
      distance: 20_000,
      duration: 1300,
      elevation: [0, 0],
      elevationInterval: 10_000,
    });

    const impacts = compareRouteAlternatives([mountainRoute, flatAlternative], evCar);

    expect(impacts[1].comparison?.isLowestEmissions).toBe(true);
    expect(impacts[1].comparison?.reason).toEqual({ kind: "less_climbing", climbMeters: 300 });
  });

  it("does not credit elevation for combustion savings that come only from distance", () => {
    const fastestRoute = makeRoute({
      distance: 4_000,
      duration: 300,
      elevation: [0, 200],
    });
    const shorterRoute = makeRoute({
      distance: 3_700,
      duration: 340,
      elevation: [0, 0],
    });

    const impacts = compareRouteAlternatives([fastestRoute, shorterRoute], petrolCar);

    expect(impacts[1].comparison?.isLowestEmissions).toBe(true);
    expect(impacts[1].comparison?.reason).toEqual({ kind: "shorter", distanceMeters: 300 });
  });

  it("identifies lowest cost route correctly", () => {
    const routeCheap = makeRoute({ distance: 30_000, duration: 1500 });
    const routeExpensive = makeRoute({ distance: 60_000, duration: 1200 });

    const impacts = compareRouteAlternatives([routeExpensive, routeCheap], petrolCar);

    expect(impacts[0].comparison?.isFastest).toBe(true);
    expect(impacts[0].comparison?.isLowestCost).toBe(false);
    expect(impacts[1].comparison?.isLowestCost).toBe(true);
    expect(impacts[1].cost.knownCost).toBeLessThan(impacts[0].cost.knownCost ?? Infinity);
  });

  it("keeps comparison reasons and model assumptions locale-neutral", () => {
    const routeFast = makeRoute({ distance: 50_000, duration: 1800 });
    const routeEco = makeRoute({ distance: 45_000, duration: 2000 });

    const impacts = compareRouteAlternatives([routeFast, routeEco], petrolCar, {
      countryCode: "DE",
    });

    expect(impacts[1].comparison?.isLowestEmissions).toBe(true);
    expect(impacts[1].comparison?.reason).toEqual({ kind: "shorter", distanceMeters: 5000 });
    const singleImpact = calculateRouteImpact(routeFast, null);
    expect(singleImpact.vehicleName).toBe("Default Car");
    expect(singleImpact.energy.provenance.assumptions[0]).toEqual({
      kind: "base_fuel_consumption",
      litersPer100Km: 6.8,
    });
  });

  it("finds the fastest route instead of assuming the first route is fastest", () => {
    const slower = makeRoute({ distance: 40_000, duration: 2400 });
    const faster = makeRoute({ distance: 50_000, duration: 1800 });
    const impacts = compareRouteAlternatives([slower, faster], petrolCar);
    expect(impacts[0].comparison?.isFastest).toBe(false);
    expect(impacts[1].comparison?.isFastest).toBe(true);
  });
});
