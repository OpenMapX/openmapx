import type { TravelMode } from "../types/routing";

export const BIKE_PROFILES = ["trekking", "road", "gravel", "mountain"] as const;
export type BikeProfile = (typeof BIKE_PROFILES)[number];
export const BIKE_HILL_PREFERENCES = ["default", "avoid", "strongly-avoid"] as const;
export type BikeHillPreference = (typeof BIKE_HILL_PREFERENCES)[number];
export interface BikeRoutingOptions {
  bikeProfile?: BikeProfile;
  bikeHillPreference?: BikeHillPreference;
  bikePreferQuietRoads?: boolean;
  bikePreferSmoothSurfaces?: boolean;
  /** Cruising speed on flat paved roads; omitted for the bike-type default. */
  bikeSpeedKmh?: number;
}
export const isBikeProfile = (value: unknown): value is BikeProfile =>
  BIKE_PROFILES.some((entry) => entry === value);
export const isBikeHillPreference = (value: unknown): value is BikeHillPreference =>
  BIKE_HILL_PREFERENCES.some((entry) => entry === value);

export const isBikeSpeedKmh = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= 60;

/** Validate optional persisted/transport fields without changing legacy payloads. */
export function validBikeRoutingOptions(raw: Record<string, unknown>): boolean {
  return (
    (raw.bikeProfile === undefined || isBikeProfile(raw.bikeProfile)) &&
    (raw.bikeHillPreference === undefined || isBikeHillPreference(raw.bikeHillPreference)) &&
    (raw.bikePreferQuietRoads === undefined || typeof raw.bikePreferQuietRoads === "boolean") &&
    (raw.bikePreferSmoothSurfaces === undefined ||
      typeof raw.bikePreferSmoothSurfaces === "boolean") &&
    (raw.bikeSpeedKmh === undefined || isBikeSpeedKmh(raw.bikeSpeedKmh))
  );
}
/** Effective preferences belong only to bicycle requests and cache identities. */
export function bicycleOptions(mode: TravelMode, raw: BikeRoutingOptions): BikeRoutingOptions {
  if (mode !== "cycling") return {};
  return {
    bikeProfile: raw.bikeProfile ?? "trekking",
    bikeHillPreference: raw.bikeHillPreference ?? "default",
    bikePreferQuietRoads: raw.bikePreferQuietRoads ?? false,
    bikePreferSmoothSurfaces: raw.bikePreferSmoothSurfaces ?? false,
    ...(raw.bikeSpeedKmh !== undefined && { bikeSpeedKmh: raw.bikeSpeedKmh }),
  };
}

export function bicycleQueryParameters(
  mode: TravelMode,
  raw: BikeRoutingOptions,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bicycleOptions(mode, raw)).map(([key, value]) => [key, String(value)]),
  );
}
