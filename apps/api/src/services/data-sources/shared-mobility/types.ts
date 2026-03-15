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
  /** Source system identifier (e.g., "citybikes/velib", "gbfs/lime-paris"). */
  source: string;
  attribution?: { label: string; url: string; license?: string; licenseUrl?: string };
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
  source: string;
  attribution?: { label: string; url: string; license?: string; licenseUrl?: string };
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
