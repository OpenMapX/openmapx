import type { EvVehicleSpec } from "../types/ev";

/** What the vehicle is. Decides the routing profile and which editor fields apply. */
export type VehicleKind = "car" | "motorcycle" | "bicycle";
export const VEHICLE_KINDS: readonly VehicleKind[] = ["car", "motorcycle", "bicycle"];

/** How it is propelled. Decides which energy fields apply. */
export type VehiclePowertrain =
  | "electric"
  | "plugin_hybrid"
  | "hybrid"
  | "petrol"
  | "diesel"
  | "other";
export const VEHICLE_POWERTRAINS: readonly VehiclePowertrain[] = [
  "electric",
  "plugin_hybrid",
  "hybrid",
  "petrol",
  "diesel",
  "other",
];

/** How a parked position was obtained. */
export type ParkedSource = "device" | "manual" | "arrival";
export const PARKED_SOURCES: readonly ParkedSource[] = ["device", "manual", "arrival"];

export interface PersonalVehicle {
  id: string;
  /** User-chosen label. Unique per user, compared case-insensitively. */
  name: string;
  kind: VehicleKind;
  powertrain: VehiclePowertrain;
  isDefault: boolean;
  /** open-ev-data preset the profile was seeded from. Provenance only; never re-read. */
  presetId: string | null;
  /** Non-null exactly when the powertrain is electric or plugin_hybrid. */
  ev: EvVehicleSpec | null;
  /** Litres per 100 km. Null for a pure BEV or a bicycle. */
  fuelConsumptionLPer100Km: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParkedLocation {
  id: string;
  /** The vehicle this position belongs to; null means no particular vehicle. */
  vehicleId: string | null;
  lat: number;
  lng: number;
  /** Reverse-geocoded label captured once at save time. Never refreshed. */
  address: string | null;
  note: string | null;
  /** Parking-meter expiry the user typed. Shown as a countdown; no reminder is delivered. */
  expiresAt: string | null;
  source: ParkedSource;
  /** Reported GPS accuracy in metres; null unless the position came from a device fix. */
  accuracyMeters: number | null;
  savedAt: string;
  updatedAt: string;
}

export type VehicleDraft = Omit<PersonalVehicle, "id" | "createdAt" | "updatedAt">;
export type ParkedDraft = Omit<ParkedLocation, "id" | "savedAt" | "updatedAt">;
