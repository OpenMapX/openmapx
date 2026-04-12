import type { LngLat } from "@openmapx/core";

export interface SharedMobilityStation {
  id: string;
  name: string;
  coordinates: LngLat;
  /** Number of available vehicles at the station. */
  availableVehicles: number;
  /** Number of empty docking slots (undefined for dockless). */
  emptySlots?: number;
  /** Total station capacity. */
  capacity?: number;
  operator?: string;
  /** Vehicle form factor(s) available at this station. */
  vehicleTypes: VehicleFormFactor[];
  /** Whether the station is currently operational. */
  isActive: boolean;
  /** Source system identifiers — all data sources that contributed to this station. */
  sources: string[];
  /** How to access the station (e.g., "App", "Chipkarte", "Bordcomputer"). */
  accessMethod?: string;
  /** Nearby public transit connections. */
  transitInfo?: { lines?: string; stops?: string };
  /** Human-readable location hint / directions to the station. */
  locationHint?: string;
  /** Station type: fixed dock or free-floating zone. */
  stationType?: "fixed" | "free";
  /** Human-readable vehicle class names available (e.g., "Mini - Elektro", "Kombi"). */
  vehicleClassNames?: string[];
  /** Station address. */
  address?: {
    street?: string;
    city?: string;
    postcode?: string;
    country?: string;
  };
  /** Operator notes (e.g., "Always bring the charging cable!"). */
  operatorNotes?: string;
  /** Per-station website or booking URL. */
  website?: string;
  /** Structured vehicle type details from GBFS (make, model, accessories, CO2). */
  vehicleTypeDetails?: VehicleTypeDetail[];
  /** Human-readable pricing summary (e.g., "from 0.28 €/km + 1.90 €/h"). */
  pricingSummary?: string;
  /** Full pricing plan details for detail view. */
  pricingDetails?: PricingDetail[];
  /** App deep links for booking. */
  rentalUris?: { web?: string; android?: string; ios?: string };
}

export interface VehicleTypeDetail {
  name: string;
  make?: string;
  model?: string;
  propulsion?: string;
  accessories?: string[];
  co2PerKm?: number;
  riderCapacity?: number;
  returnConstraint?: string;
}

export interface PricingDetail {
  name: string;
  description?: string;
  currency: string;
  perKmRate?: number;
  /** Normalized hourly rate (computed from per_min_pricing rate/interval). */
  perHourRate?: number;
  flatRate?: number;
}

export interface SharedMobilityVehicle {
  id: string;
  coordinates: LngLat;
  /** Vehicle form factor. */
  formFactor: VehicleFormFactor;
  /** Propulsion type. */
  propulsion?: VehiclePropulsion;
  /** Battery level 0–100 (for electric vehicles). */
  batteryLevel?: number;
  /** Estimated range in meters. */
  rangeMeters?: number;
  /** Whether currently reserved. */
  isReserved: boolean;
  /** Whether currently disabled. */
  isDisabled: boolean;
  operator?: string;
  sources: string[];
}

export type VehicleFormFactor =
  | "bicycle"
  | "cargo_bicycle"
  | "scooter_standing"
  | "scooter_seated"
  | "car"
  | "moped"
  | "other";

export type VehiclePropulsion =
  | "human"
  | "electric_assist"
  | "electric"
  | "combustion"
  | "combustion_diesel"
  | "hybrid"
  | "plug_in_hybrid"
  | "hydrogen_fuel_cell";

export interface GbfsCatalogEntry {
  countryCode: string;
  name: string;
  location: string;
  systemId: string;
  url: string;
  autoDiscoveryUrl: string;
}

export interface GbfsSystemInfo {
  systemId: string;
  name: string;
  operator?: string;
  url?: string;
  timezone: string;
  /** OSM-format opening hours. */
  openingHours?: string;
}

export interface GbfsStationInfo {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  capacity?: number;
  vehicleTypesAvailable?: string[];
  rentalUris?: { web?: string; android?: string; ios?: string };
}

export interface GbfsStationStatus {
  stationId: string;
  numBikesAvailable: number;
  numDocksAvailable?: number;
  isInstalled: boolean;
  isRenting: boolean;
  isReturning: boolean;
  vehicleTypesAvailable?: { vehicleTypeId: string; count: number }[];
}

export interface GbfsVehicleType {
  vehicleTypeId: string;
  formFactor: string;
  propulsionType: string;
  name?: string;
  maxRangeMeters?: number;
  make?: string;
  model?: string;
  riderCapacity?: number;
  vehicleAccessories?: string[];
  co2PerKm?: number;
  returnConstraint?: string;
  defaultPricingPlanId?: string;
  pricingPlanIds?: string[];
}

export interface GbfsPricingPlan {
  planId: string;
  name: string;
  currency: string;
  price: number;
  isTaxable: boolean;
  description?: string;
  perKmPricing?: { start: number; rate: number; interval: number; end?: number }[];
  perMinPricing?: { start: number; rate: number; interval: number; end?: number }[];
}

export interface GbfsVehicleStatus {
  bikeId: string;
  lat?: number;
  lon?: number;
  isReserved: boolean;
  isDisabled: boolean;
  vehicleTypeId?: string;
  currentRangeMeters?: number;
  currentFuelPercent?: number;
  stationId?: string;
}
