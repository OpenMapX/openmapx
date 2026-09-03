import type { Route, TravelMode } from "../types/routing";
import type { PersonalVehicle, VehicleKind, VehiclePowertrain } from "../vehicles/types";
import { getRegionalBenchmark } from "./benchmarks";
import type {
  BenchmarkSource,
  ImpactAssumption,
  MonetaryCostBreakdown,
  ProvenanceKind,
  ProvenanceMeta,
  RouteImpact,
  TollStatus,
} from "./types";

export interface CalculateImpactOptions {
  routeIndex?: number;
  countryCode?: string | null;
  currency?: string | null;
  fuelPricePerLiter?: number | null;
  fuelPriceSource?: string | null;
  fuelPriceProvenanceKind?: ProvenanceKind;
  fuelPriceTimestamp?: string | null;
  fuelPriceSourceUrl?: string | null;
  electricityPricePerKwh?: number | null;
  electricityPriceSource?: string | null;
  electricityPriceProvenanceKind?: ProvenanceKind;
  electricityPriceTimestamp?: string | null;
  electricityPriceSourceUrl?: string | null;
  ambientTempC?: number;
  occupancy?: number;
  transitFare?: number | null;
  /** Injected by batch calculations so every alternative has one timestamp. */
  calculatedAt?: string;
}

interface FuelProperties {
  tailpipeGramsPerLiter: number;
  upstreamGramsPerLiter: number;
  source: BenchmarkSource;
}

interface ElevationProfile {
  ascentMeters: number;
  descentMeters: number;
}

const MODEL = {
  chargingEfficiency: 0.9,
  defaultAmbientTempC: 20,
  defaultCarFuelLitersPer100Km: 6.8,
  defaultEvMassTonnes: 1.8,
  defaultEvWhPerKm: 180,
  defaultHybridFuelLitersPer100Km: 4.5,
  defaultDieselFuelLitersPer100Km: 5.8,
  defaultMotorcycleFuelLitersPer100Km: 4.2,
  evRegenEfficiency: 0.6,
  gravityWhPerMeterTonne: (9.81 * 1000) / 3600,
  transitFallbackGramsPerPassengerKm: 101.51,
  maxOccupancy: 20,
} as const;

const SUPPORTED_CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

const GLEC_FUEL_SOURCE: BenchmarkSource = {
  citation: "GLEC Framework v3 European fuel emission factors",
  url: "https://www.smartfreightcentre.org/documents/328/GLEC_FRAMEWORK_v3_UPDATED_02_04_24.pdf",
  effectiveAt: "2024-04-02",
  scope: "European default well-to-wheel factors; vehicle-specific fuel use is applied separately",
};

function glecFuelProperties(
  densityKgPerLiter: number,
  lowerHeatingValueMjPerKg: number,
  tailpipeGramsPerMj: number,
  wellToWheelGramsPerMj: number,
): FuelProperties {
  const energyMjPerLiter = densityKgPerLiter * lowerHeatingValueMjPerKg;
  const tailpipeGramsPerLiter = energyMjPerLiter * tailpipeGramsPerMj;
  return {
    tailpipeGramsPerLiter,
    upstreamGramsPerLiter: energyMjPerLiter * wellToWheelGramsPerMj - tailpipeGramsPerLiter,
    source: GLEC_FUEL_SOURCE,
  };
}

// GLEC v3 Module 1, European-source rows for gasoline and diesel.
const PETROL = glecFuelProperties(0.74, 42.5, 75.1, 99.1);
const DIESEL = glecFuelProperties(0.83, 42.8, 74.1, 96.6);

const TRANSIT_FALLBACK_SOURCE: BenchmarkSource = {
  citation: "UK DESNZ 2026 average local bus factor",
  url: "https://assets.publishing.service.gov.uk/media/6a2940543b15d05a7ce3202e/2026-GHG-conversion-factors-methodology-report.pdf",
  effectiveAt: "2026",
  scope: "Conservative generic fallback when the routing provider supplies no itinerary emissions",
};

/** Temperature multiplier for EV auxiliary loads, bounded against bad sensor data. */
export function tempDerate(tempC: number): number {
  if (!Number.isFinite(tempC)) return 1;
  const delta = tempC - MODEL.defaultAmbientTempC;
  const factor = 1 + (delta < 0 ? -delta * 0.012 : delta * 0.004);
  return Math.min(1.8, Math.max(1, factor));
}

function finitePositive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function requiredVehicleKind(mode: TravelMode): VehicleKind | null {
  if (mode === "driving") return "car";
  if (mode === "motorcycle") return "motorcycle";
  if (mode === "cycling") return "bicycle";
  return null;
}

export function compatibleImpactVehicles(
  mode: TravelMode | undefined,
  vehicles: PersonalVehicle[] | undefined,
): PersonalVehicle[] {
  if (!mode || !vehicles?.length) return [];
  const requiredKind = requiredVehicleKind(mode);
  return requiredKind ? vehicles.filter((vehicle) => vehicle.kind === requiredKind) : [];
}

export function resolveImpactVehicle(
  mode: TravelMode | undefined,
  vehicles: PersonalVehicle[] | undefined,
  requestedId?: string | null,
): PersonalVehicle | null {
  if (!mode) return null;
  const compatible = compatibleImpactVehicles(mode, vehicles);
  if (compatible.length === 0) return null;
  if (requestedId === null) return null;
  if (requestedId !== undefined) {
    const requested = compatible.find((vehicle) => vehicle.id === requestedId);
    if (requested) return requested;
  }
  return compatible.find((vehicle) => vehicle.isDefault) ?? compatible[0] ?? null;
}

function assertCompatibleVehicle(route: Route, vehicle: PersonalVehicle | null): void {
  if (!vehicle) return;
  const requiredKind = requiredVehicleKind(route.mode);
  if (!requiredKind || vehicle.kind !== requiredKind) {
    throw new RangeError(`${vehicle.kind} vehicle is not compatible with ${route.mode} routing`);
  }
  if (vehicle.powertrain === "plugin_hybrid") {
    throw new RangeError(
      "Plug-in hybrid impact requires electric share, charge state, and fuel consumption inputs",
    );
  }
  if (vehicle.powertrain === "other" && requiredKind !== "bicycle") {
    throw new RangeError("Unsupported powertrain for motorized impact calculation");
  }
}

function normalizeOccupancy(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MODEL.maxOccupancy, Math.max(1, Math.round(value as number)));
}

function normalizeCurrency(value: string | null | undefined, fallback: string): string {
  const candidate = value?.trim().toUpperCase();
  return candidate && SUPPORTED_CURRENCY_CODES.has(candidate) ? candidate : fallback;
}

function elevationProfile(route: Route): ElevationProfile | null {
  const samples = route.elevation;
  if (!samples || samples.length < 2) return null;
  let ascentMeters = 0;
  let descentMeters = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const delta = current - previous;
    if (Math.abs(delta) < 1) continue;
    if (delta > 0) ascentMeters += delta;
    else descentMeters -= delta;
  }
  return { ascentMeters, descentMeters };
}

function provenance(
  calculatedAt: string,
  kind: ProvenanceKind,
  citation: string,
  assumptions: ImpactAssumption[],
  source?: { timestamp?: string | null; url?: string | null },
): ProvenanceMeta {
  return {
    kind,
    timestamp: source?.timestamp ?? calculatedAt,
    calculatedAt,
    citation,
    ...(source?.url ? { sourceUrl: source.url } : {}),
    assumptions,
  };
}

function withPerPerson(
  result: RouteImpact,
  emissionsGrams: number,
  knownCost: number | null,
  totalCost: number | null,
): RouteImpact {
  if (result.occupancy > 1) {
    result.perPerson = {
      emissionsGrams: emissionsGrams / result.occupancy,
      knownCost: knownCost === null ? null : knownCost / result.occupancy,
      totalCost: totalCost === null ? null : totalCost / result.occupancy,
    };
  }
  return result;
}

function calculateEnergyCost(
  amount: number,
  unitPrice: number,
  currency: string,
  calculatedAt: string,
  override: {
    source?: string | null;
    kind?: ProvenanceKind;
    timestamp?: string | null;
    sourceUrl?: string | null;
  } | null,
  benchmarkSource: BenchmarkSource,
): Pick<MonetaryCostBreakdown, "energyCost" | "energyCostProvenance"> {
  const isOverride = override !== null;
  return {
    energyCost: amount * unitPrice,
    energyCostProvenance: provenance(
      calculatedAt,
      isOverride ? (override.kind ?? "user_override") : "defaulted",
      isOverride ? override.source?.trim() || "Custom price" : benchmarkSource.citation,
      [{ kind: "unit_price", value: unitPrice, currency }],
      isOverride
        ? { timestamp: override.timestamp, url: override.sourceUrl }
        : { timestamp: benchmarkSource.effectiveAt, url: benchmarkSource.url },
    ),
  };
}

function activeImpact(
  route: Route,
  vehicle: PersonalVehicle | null,
  routeIndex: number,
  currency: string,
  calculatedAt: string,
): RouteImpact {
  const isCycling = route.mode === "cycling" || vehicle?.kind === "bicycle";
  const zero = provenance(calculatedAt, "calculated", "Active mobility", [
    { kind: "active_mobility_zero" },
  ]);
  return {
    routeIndex,
    vehicleId: vehicle?.id ?? null,
    vehicleName: vehicle?.name ?? (isCycling ? "Bicycle" : "Walking"),
    vehiclePowertrain: vehicle?.powertrain ?? "other",
    energy: { fuelLiters: null, electricityKwh: null, provenance: zero },
    emissions: { totalGrams: 0, tailpipeGrams: 0, upstreamGrams: 0, provenance: zero },
    cost: {
      costType: "active",
      currency,
      energyCost: 0,
      energyCostProvenance: zero,
      tollStatus: "no_tolls",
      tollCost: null,
      transitFare: null,
      knownCost: 0,
      totalCost: 0,
      costCompleteness: "complete",
    },
    occupancy: 1,
  };
}

function transitImpact(
  route: Route,
  routeIndex: number,
  currency: string,
  calculatedAt: string,
  fareInput: number | null | undefined,
): RouteImpact {
  const providerEmissions =
    typeof route.co2Grams === "number" && Number.isFinite(route.co2Grams) && route.co2Grams >= 0
      ? route.co2Grams
      : null;
  const totalGrams =
    providerEmissions ??
    (Math.max(0, route.distance) / 1000) * MODEL.transitFallbackGramsPerPassengerKm;
  const fare = finiteNonNegative(fareInput);
  const shared = provenance(
    calculatedAt,
    "defaulted",
    TRANSIT_FALLBACK_SOURCE.citation,
    [
      {
        kind: "transit_fallback",
        gramsPerPassengerKm: MODEL.transitFallbackGramsPerPassengerKm,
      },
    ],
    {
      timestamp: TRANSIT_FALLBACK_SOURCE.effectiveAt,
      url: TRANSIT_FALLBACK_SOURCE.url,
    },
  );
  return {
    routeIndex,
    vehicleId: null,
    vehicleName: "Public transport",
    vehiclePowertrain: "other",
    energy: { fuelLiters: null, electricityKwh: null, provenance: shared },
    emissions: {
      totalGrams,
      tailpipeGrams: 0,
      upstreamGrams: totalGrams,
      provenance:
        providerEmissions === null
          ? shared
          : provenance(calculatedAt, "provider", "Transit provider", [
              { kind: "provider_per_passenger" },
            ]),
    },
    cost: {
      costType: "transit",
      currency,
      energyCost: 0,
      energyCostProvenance: shared,
      tollStatus: "no_tolls",
      tollCost: null,
      transitFare: fare,
      knownCost: fare,
      totalCost: fare,
      costCompleteness: fare === null ? "unavailable" : "complete",
    },
    // Transit figures are already per passenger; car occupancy must not divide them again.
    occupancy: 1,
  };
}

function electricImpact(
  route: Route,
  vehicle: PersonalVehicle,
  options: CalculateImpactOptions,
  routeIndex: number,
  currency: string,
  calculatedAt: string,
): RouteImpact {
  const benchmark = getRegionalBenchmark(options.countryCode, options.currency);
  const baseWhPerKm = finitePositive(vehicle.ev?.baseWhPerKm) ?? MODEL.defaultEvWhPerKm;
  const massTonnes = finitePositive(vehicle.ev?.massTonnes) ?? MODEL.defaultEvMassTonnes;
  const ambientTemp = Number.isFinite(options.ambientTempC)
    ? (options.ambientTempC as number)
    : MODEL.defaultAmbientTempC;
  const derate = tempDerate(ambientTemp);
  const profile = elevationProfile(route);
  const distanceWh = (Math.max(0, route.distance) / 1000) * baseWhPerKm * derate;
  const ascentWh = (profile?.ascentMeters ?? 0) * MODEL.gravityWhPerMeterTonne * massTonnes;
  const recoveredWh =
    (profile?.descentMeters ?? 0) *
    MODEL.gravityWhPerMeterTonne *
    massTonnes *
    MODEL.evRegenEfficiency;
  const batteryKwh = Math.max(0, distanceWh + ascentWh - recoveredWh) / 1000;
  const gridKwh = batteryKwh / MODEL.chargingEfficiency;
  const priceOverride = finitePositive(options.electricityPricePerKwh);
  const price = priceOverride ?? benchmark.electricityPricePerKwh.value;
  const costParts = calculateEnergyCost(
    gridKwh,
    price,
    currency,
    calculatedAt,
    priceOverride === null
      ? null
      : {
          source: options.electricityPriceSource,
          kind: options.electricityPriceProvenanceKind,
          timestamp: options.electricityPriceTimestamp,
          sourceUrl: options.electricityPriceSourceUrl,
        },
    benchmark.electricityPricePerKwh.source,
  );
  const tollStatus: TollStatus = "unknown";
  const totalCost = null;
  const gridIntensity = benchmark.gridCarbonIntensityGramsPerKwh;
  const totalGrams = gridKwh * gridIntensity.value;
  const occupancy = normalizeOccupancy(options.occupancy);
  const assumptions = [
    { kind: "base_electric_consumption", whPerKm: baseWhPerKm },
    { kind: "ambient_temperature", celsius: ambientTemp, factor: derate },
    { kind: "charging_efficiency", percent: Math.round(MODEL.chargingEfficiency * 100) },
    profile
      ? {
          kind: "elevation",
          ascentMeters: Math.round(profile.ascentMeters),
          descentMeters: Math.round(profile.descentMeters),
          regenPercent: Math.round(MODEL.evRegenEfficiency * 100),
        }
      : { kind: "flat_terrain" },
  ] satisfies ImpactAssumption[];
  return withPerPerson(
    {
      routeIndex,
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      vehiclePowertrain: vehicle.powertrain,
      energy: {
        fuelLiters: null,
        electricityKwh: gridKwh,
        provenance: provenance(calculatedAt, "calculated", vehicle.name, assumptions),
      },
      emissions: {
        totalGrams,
        tailpipeGrams: 0,
        upstreamGrams: totalGrams,
        provenance: provenance(
          calculatedAt,
          "calculated",
          gridIntensity.source.citation,
          [{ kind: "grid_intensity", gramsPerKwh: gridIntensity.value }, { kind: "zero_tailpipe" }],
          { timestamp: gridIntensity.source.effectiveAt, url: gridIntensity.source.url },
        ),
      },
      cost: {
        costType: "road",
        currency,
        ...costParts,
        tollStatus,
        tollCost: null,
        transitFare: null,
        knownCost: costParts.energyCost,
        totalCost,
        costCompleteness: "partial",
      },
      occupancy,
    },
    totalGrams,
    costParts.energyCost,
    totalCost,
  );
}

function combustionImpact(
  route: Route,
  vehicle: PersonalVehicle | null,
  options: CalculateImpactOptions,
  routeIndex: number,
  currency: string,
  calculatedAt: string,
): RouteImpact {
  const benchmark = getRegionalBenchmark(options.countryCode, options.currency);
  const powertrain: VehiclePowertrain = vehicle?.powertrain ?? "petrol";
  const diesel = powertrain === "diesel";
  const hybrid = powertrain === "hybrid";
  const motorcycle = route.mode === "motorcycle";
  const properties = diesel ? DIESEL : PETROL;
  const defaultConsumption = hybrid
    ? MODEL.defaultHybridFuelLitersPer100Km
    : diesel
      ? MODEL.defaultDieselFuelLitersPer100Km
      : motorcycle
        ? MODEL.defaultMotorcycleFuelLitersPer100Km
        : MODEL.defaultCarFuelLitersPer100Km;
  const configuredConsumption = finitePositive(vehicle?.fuelConsumptionLPer100Km);
  const litersPer100Km = configuredConsumption ?? defaultConsumption;
  const fuelLiters = (Math.max(0, route.distance) / 1000 / 100) * litersPer100Km;
  const tailpipeGrams = fuelLiters * properties.tailpipeGramsPerLiter;
  const upstreamGrams = fuelLiters * properties.upstreamGramsPerLiter;
  const totalGrams = tailpipeGrams + upstreamGrams;
  const priceOverride = finitePositive(options.fuelPricePerLiter);
  const price =
    priceOverride ??
    (diesel ? benchmark.dieselPricePerLiter.value : benchmark.petrolPricePerLiter.value);
  const benchmarkFuelPrice = diesel ? benchmark.dieselPricePerLiter : benchmark.petrolPricePerLiter;
  const costParts = calculateEnergyCost(
    fuelLiters,
    price,
    currency,
    calculatedAt,
    priceOverride === null
      ? null
      : {
          source: options.fuelPriceSource,
          kind: options.fuelPriceProvenanceKind,
          timestamp: options.fuelPriceTimestamp,
          sourceUrl: options.fuelPriceSourceUrl,
        },
    benchmarkFuelPrice.source,
  );
  const tollStatus: TollStatus = "unknown";
  const totalCost = null;
  const occupancy = normalizeOccupancy(options.occupancy);
  const vehicleName = vehicle?.name ?? (motorcycle ? "Default Motorcycle" : "Default Car");

  return withPerPerson(
    {
      routeIndex,
      vehicleId: vehicle?.id ?? null,
      vehicleName,
      vehiclePowertrain: powertrain,
      energy: {
        fuelLiters,
        electricityKwh: null,
        provenance: provenance(
          calculatedAt,
          !vehicle || configuredConsumption === null ? "defaulted" : "calculated",
          vehicleName,
          [{ kind: "base_fuel_consumption", litersPer100Km }],
        ),
      },
      emissions: {
        totalGrams,
        tailpipeGrams,
        upstreamGrams,
        provenance: provenance(
          calculatedAt,
          "defaulted",
          properties.source.citation,
          [
            { kind: "tailpipe_factor", gramsPerLiter: properties.tailpipeGramsPerLiter },
            { kind: "upstream_factor", gramsPerLiter: properties.upstreamGramsPerLiter },
          ],
          { timestamp: properties.source.effectiveAt, url: properties.source.url },
        ),
      },
      cost: {
        costType: "road",
        currency,
        ...costParts,
        tollStatus,
        tollCost: null,
        transitFare: null,
        knownCost: costParts.energyCost,
        totalCost,
        costCompleteness: "partial",
      },
      occupancy,
    },
    totalGrams,
    costParts.energyCost,
    totalCost,
  );
}

/** Calculate energy, greenhouse-gas emissions, and energy cost for one route. */
export function calculateRouteImpact(
  route: Route,
  vehicle: PersonalVehicle | null,
  options: CalculateImpactOptions = {},
): RouteImpact {
  assertCompatibleVehicle(route, vehicle);
  const routeIndex = options.routeIndex ?? 0;
  const benchmark = getRegionalBenchmark(options.countryCode, options.currency);
  const hasExplicitPrice =
    route.mode === "transit"
      ? finiteNonNegative(options.transitFare) !== null
      : vehicle?.powertrain === "electric"
        ? finitePositive(options.electricityPricePerKwh) !== null
        : route.mode === "driving" || route.mode === "motorcycle"
          ? finitePositive(options.fuelPricePerLiter) !== null
          : false;
  const currency = hasExplicitPrice
    ? normalizeCurrency(options.currency, benchmark.currency)
    : benchmark.currency;
  const calculatedAt = options.calculatedAt ?? new Date().toISOString();

  if (route.mode === "walking" || route.mode === "cycling" || vehicle?.kind === "bicycle") {
    return activeImpact(route, vehicle, routeIndex, currency, calculatedAt);
  }
  if (route.mode === "transit") {
    return transitImpact(route, routeIndex, currency, calculatedAt, options.transitFare);
  }
  if (vehicle?.powertrain === "electric") {
    return electricImpact(route, vehicle, options, routeIndex, currency, calculatedAt);
  }
  return combustionImpact(route, vehicle, options, routeIndex, currency, calculatedAt);
}

function closeEnough(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * 16 * scale;
}

/** Compare alternatives against the genuinely fastest route, regardless of array ordering. */
export function compareRouteAlternatives(
  routes: Route[],
  vehicle: PersonalVehicle | null,
  options: CalculateImpactOptions = {},
): RouteImpact[] {
  if (routes.length === 0) return [];
  const calculatedAt = options.calculatedAt ?? new Date().toISOString();
  const impacts = routes.map((route, routeIndex) =>
    calculateRouteImpact(route, vehicle, { ...options, calculatedAt, routeIndex }),
  );
  const fastestIndex = routes.reduce(
    (best, route, index) => (route.duration < routes[best].duration ? index : best),
    0,
  );
  const fastest = impacts[fastestIndex];
  const minEmissions = Math.min(...impacts.map((impact) => impact.emissions.totalGrams));
  const knownCosts = impacts.flatMap((impact) =>
    impact.cost.knownCost === null ? [] : [impact.cost.knownCost],
  );
  const minCost = knownCosts.length > 0 ? Math.min(...knownCosts) : null;

  return impacts.map((impact, index) => {
    const emissionsDeltaGrams = impact.emissions.totalGrams - fastest.emissions.totalGrams;
    const emissionsDeltaPct =
      fastest.emissions.totalGrams > 0
        ? (emissionsDeltaGrams / fastest.emissions.totalGrams) * 100
        : 0;
    const costDelta =
      impact.cost.knownCost !== null && fastest.cost.knownCost !== null
        ? impact.cost.knownCost - fastest.cost.knownCost
        : null;
    const isLowestEmissions =
      index !== fastestIndex &&
      closeEnough(impact.emissions.totalGrams, minEmissions) &&
      emissionsDeltaPct <= -5;
    let reason: NonNullable<RouteImpact["comparison"]>["reason"] = null;
    if (isLowestEmissions) {
      const distanceMeters = routes[fastestIndex].distance - routes[index].distance;
      const climbMeters =
        (elevationProfile(routes[fastestIndex])?.ascentMeters ?? 0) -
        (elevationProfile(routes[index])?.ascentMeters ?? 0);
      if (distanceMeters > 0) reason = { kind: "shorter", distanceMeters };
      else if (vehicle?.powertrain === "electric" && climbMeters >= 50)
        reason = { kind: "less_climbing", climbMeters };
      else if (vehicle?.powertrain === "electric") reason = { kind: "electric_efficiency" };
      else reason = { kind: "lower_consumption" };
    }
    impact.comparison = {
      isLowestEmissions,
      isLowestCost:
        impact.cost.knownCost !== null &&
        minCost !== null &&
        closeEnough(impact.cost.knownCost, minCost),
      isFastest: index === fastestIndex,
      emissionsDeltaGrams,
      emissionsDeltaPct,
      costDelta,
      reason,
    };
    return impact;
  });
}
