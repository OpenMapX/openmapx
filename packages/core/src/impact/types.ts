/**
 * Provenance-aware route impact and emissions types (Issue #304).
 * Simplified client-side model inspired by ISO 14083 / GLEC Framework —
 * not a certified compliance declaration.
 */

export type ProvenanceKind = "provider" | "calculated" | "defaulted" | "user_override";

export const PROVENANCE_KINDS: readonly ProvenanceKind[] = [
  "provider",
  "calculated",
  "defaulted",
  "user_override",
];

/** Locale-neutral inputs and modeling decisions shown in impact provenance. */
export type ImpactAssumption =
  | { kind: "unit_price"; value: number; currency: string }
  | { kind: "active_mobility_zero" }
  | { kind: "transit_fallback"; gramsPerPassengerKm: number }
  | { kind: "provider_per_passenger" }
  | { kind: "base_electric_consumption"; whPerKm: number }
  | { kind: "ambient_temperature"; celsius: number; factor: number }
  | { kind: "charging_efficiency"; percent: number }
  | {
      kind: "elevation";
      ascentMeters: number;
      descentMeters: number;
      regenPercent?: number;
    }
  | { kind: "flat_terrain" }
  | { kind: "grid_intensity"; gramsPerKwh: number }
  | { kind: "zero_tailpipe" }
  | { kind: "base_fuel_consumption"; litersPer100Km: number }
  | { kind: "tailpipe_factor"; gramsPerLiter: number }
  | { kind: "upstream_factor"; gramsPerLiter: number }
  | { kind: "fuel_price_sample"; radiusMeters: number; stationCount: number };

export interface ProvenanceMeta {
  kind: ProvenanceKind;
  /** ISO 8601 timestamp when data was fetched or benchmark was versioned. */
  timestamp: string;
  /** ISO 8601 timestamp when this result was calculated. */
  calculatedAt: string;
  /** Human-readable citation of data source (e.g. "EEA 2024", "Tankerkönig DE", "User Garage"). */
  citation: string;
  sourceUrl?: string;
  /** Structured assumptions used in the calculation, localized at the UI edge. */
  assumptions: ImpactAssumption[];
}

export interface EmissionsBreakdown {
  /** Well-to-Wheel (WTW) total greenhouse gas emissions in grams CO₂ equivalent. */
  totalGrams: number;
  /** Direct operational tailpipe emissions (Tank-to-Wheel / TTW). 0 for pure EVs. */
  tailpipeGrams: number;
  /** Upstream emissions (Well-to-Tank / WTT / electric power grid generation). */
  upstreamGrams: number;
  provenance: ProvenanceMeta;
}

export interface EnergyConsumption {
  /** Fuel consumed in liters (for petrol/diesel/hybrid). Null for pure electric or bicycle. */
  fuelLiters: number | null;
  /** Electricity drawn from the grid in kWh, including charging losses. */
  electricityKwh: number | null;
  provenance: ProvenanceMeta;
}

export type TollStatus = "unknown" | "no_tolls" | "tolls_included" | "tolls_unknown";

export const TOLL_STATUSES: readonly TollStatus[] = [
  "unknown",
  "no_tolls",
  "tolls_included",
  "tolls_unknown",
];

export interface MonetaryCostBreakdown {
  costType: "road" | "transit" | "active";
  currency: string; // ISO 4217 code (EUR, USD, GBP, CHF)
  /** Estimated fuel or electricity cost. */
  energyCost: number;
  energyCostProvenance: ProvenanceMeta;
  /** Toll status: known amount, flagged as tolls apply but unknown amount, or no tolls. */
  tollStatus: TollStatus;
  tollCost: number | null;
  /** Transit fare if known from provider. Null otherwise. */
  transitFare: number | null;
  /** Sum of the cost components that are known, even when the final total is incomplete. */
  knownCost: number | null;
  /** Total monetary cost if all components are known. Null if tolls/fares are unknown. */
  totalCost: number | null;
  costCompleteness: "complete" | "partial" | "unavailable";
}

export interface RouteImpact {
  routeIndex: number;
  vehicleId: string | null;
  vehicleName: string;
  vehiclePowertrain: string;
  energy: EnergyConsumption;
  emissions: EmissionsBreakdown;
  cost: MonetaryCostBreakdown;
  /** Passenger count divisor used for per-person metrics (default: 1). */
  occupancy: number;
  /** Per-person metrics when occupancy > 1. */
  perPerson?: {
    emissionsGrams: number;
    knownCost: number | null;
    totalCost: number | null;
  };
  /** Relative comparison against the route with the shortest duration. */
  comparison?: {
    isLowestEmissions: boolean;
    isLowestCost: boolean;
    isFastest: boolean;
    emissionsDeltaGrams: number; // negative = cleaner
    emissionsDeltaPct: number;
    costDelta: number | null; // negative = cheaper
    /** Locale-neutral reason for the eco recommendation. */
    reason:
      | { kind: "shorter"; distanceMeters: number }
      | { kind: "less_climbing"; climbMeters: number }
      | { kind: "electric_efficiency" }
      | { kind: "lower_consumption" }
      | null;
  };
}

export type RouteImpactUnavailableReason =
  | "plugin_hybrid_inputs_missing"
  | "unsupported_powertrain";

export interface RegionalBenchmark {
  countryCode: string;
  currency: string;
  petrolPricePerLiter: BenchmarkValue;
  dieselPricePerLiter: BenchmarkValue;
  electricityPricePerKwh: BenchmarkValue;
  gridCarbonIntensityGramsPerKwh: BenchmarkValue;
}

export interface BenchmarkSource {
  citation: string;
  url: string;
  effectiveAt: string;
  scope: string;
}

export interface BenchmarkValue {
  value: number;
  unit: "per_liter" | "per_kwh" | "grams_co2e_per_kwh";
  source: BenchmarkSource;
}
