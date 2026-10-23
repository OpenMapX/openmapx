import type { ParkedLocation, PersonalVehicle } from "../api/contracts/garage/schemas";

export type { ParkedLocation, PersonalVehicle } from "../api/contracts/garage/schemas";

/** What the vehicle is. Decides the routing profile and which editor fields apply. */
export const VEHICLE_KINDS = ["car", "motorcycle", "bicycle"] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

/** How it is propelled. Decides which energy fields apply. */
export const VEHICLE_POWERTRAINS = [
  "electric",
  "plugin_hybrid",
  "hybrid",
  "petrol",
  "diesel",
  "other",
] as const;
export type VehiclePowertrain = (typeof VEHICLE_POWERTRAINS)[number];

/** How a parked position was obtained. */
export const PARKED_SOURCES = ["device", "manual", "arrival"] as const;
export type ParkedSource = (typeof PARKED_SOURCES)[number];

export type VehicleDraft = Omit<PersonalVehicle, "id" | "createdAt" | "updatedAt">;
export type ParkedDraft = Omit<ParkedLocation, "id" | "savedAt" | "updatedAt">;
