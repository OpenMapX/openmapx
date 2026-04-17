import { type Client, createClient } from "@hey-api/client-fetch";
import type {
  RentalFormFactor,
  RentalProvider,
  RentalStation,
  RentalVehicle,
} from "@motis-project/motis-client";
import { rentals } from "@motis-project/motis-client";
import type { LngLat } from "@openmapx/core";

interface MotisInstance {
  client: Client;
  prefix: string;
  provider: string;
}

const transitousInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: process.env.TRANSITOUS_URL ?? "https://api.transitous.org",
  });
  return { client, prefix: "mo:", provider: "mo" };
})();

const motisLocalInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: process.env.MOTIS_URL ?? "http://localhost:8081",
  });
  return { client, prefix: "ms:", provider: "ms" };
})();

async function isMotisLocalReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${process.env.MOTIS_URL ?? "http://localhost:8081"}/api/v1/plan`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
  VehiclePropulsion,
} from "./types.js";

const SOURCE = "transitous";

function mapFormFactor(ff: RentalFormFactor): VehicleFormFactor {
  switch (ff) {
    case "BICYCLE":
      return "bicycle";
    case "CARGO_BICYCLE":
      return "cargo_bicycle";
    case "CAR":
      return "car";
    case "MOPED":
      return "moped";
    case "SCOOTER_STANDING":
      return "scooter_standing";
    case "SCOOTER_SEATED":
      return "scooter_seated";
    default:
      return "other";
  }
}

function mapPropulsion(p: string): VehiclePropulsion | undefined {
  switch (p) {
    case "HUMAN":
      return "human";
    case "ELECTRIC_ASSIST":
      return "electric_assist";
    case "ELECTRIC":
      return "electric";
    case "COMBUSTION":
      return "combustion";
    case "COMBUSTION_DIESEL":
      return "combustion_diesel";
    case "HYBRID":
      return "hybrid";
    case "PLUG_IN_HYBRID":
      return "plug_in_hybrid";
    case "HYDROGEN_FUEL_CELL":
      return "hydrogen_fuel_cell";
    default:
      return undefined;
  }
}

function resolveOperator(providerId: string, providerNames: Map<string, string>): string {
  return providerNames.get(providerId) ?? providerId;
}

function mapStation(s: RentalStation, providerNames: Map<string, string>): SharedMobilityStation {
  const coordinates: LngLat = [s.lon, s.lat];
  const vehicleTypes = s.formFactors.map(mapFormFactor);

  const totalAvailable = Object.values(s.vehicleTypesAvailable).reduce(
    (sum, count) => sum + count,
    0,
  );
  const totalDocks = Object.values(s.vehicleDocksAvailable).reduce((sum, count) => sum + count, 0);

  return {
    id: `motis:${s.id}`,
    name: s.name,
    coordinates,
    availableVehicles: totalAvailable,
    emptySlots: totalDocks > 0 ? totalDocks : undefined,
    operator: resolveOperator(s.providerId, providerNames),
    vehicleTypes: vehicleTypes.length > 0 ? vehicleTypes : ["other"],
    isActive: s.isRenting || s.isReturning,
    sources: [SOURCE],
    website: s.rentalUriWeb,
  };
}

function mapVehicle(v: RentalVehicle, providerNames: Map<string, string>): SharedMobilityVehicle {
  const coordinates: LngLat = [v.lon, v.lat];

  return {
    id: `motis:${v.id}`,
    coordinates,
    formFactor: mapFormFactor(v.formFactor),
    propulsion: mapPropulsion(v.propulsionType),
    isReserved: v.isReserved,
    isDisabled: v.isDisabled,
    operator: resolveOperator(v.providerId, providerNames),
    sources: [SOURCE],
  };
}

function buildProviderNames(providers: RentalProvider[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of providers) {
    const displayName = (p.name || p.operator || p.id).replace(/\b\w/g, (c) => c.toUpperCase());
    map.set(p.id, displayName);
  }
  return map;
}

export async function fetchMotisRentals(
  bbox: [number, number, number, number],
  formFactors?: VehicleFormFactor[],
): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }> {
  const [west, south, east, north] = bbox;

  // Prefer self-hosted MOTIS, fall back to Transitous
  const instances = (await isMotisLocalReachable())
    ? [motisLocalInstance, transitousInstance]
    : [transitousInstance];

  let responseData: Awaited<ReturnType<typeof rentals>>["data"] | undefined;
  for (const instance of instances) {
    const response = await rentals({
      client: instance.client,
      query: {
        min: `${south},${west}`,
        max: `${north},${east}`,
        withProviders: true,
        withStations: true,
        withVehicles: true,
      },
    });
    if (!response.error && response.data) {
      responseData = response.data;
      break;
    }
  }

  if (!responseData) {
    return { stations: [], vehicles: [] };
  }

  const { providers: rawProviders, stations: rawStations, vehicles: rawVehicles } = responseData;
  const providerNames = buildProviderNames(rawProviders ?? []);

  let filteredStations = rawStations;
  if (formFactors && formFactors.length > 0) {
    filteredStations = rawStations.filter((s) =>
      s.formFactors.some((ff) => formFactors.includes(mapFormFactor(ff))),
    );
  }

  const stations = filteredStations.map((s) => mapStation(s, providerNames));

  const activeVehicles = rawVehicles.filter((v) => !v.isReserved && !v.isDisabled);
  let filteredVehicles = activeVehicles;
  if (formFactors && formFactors.length > 0) {
    filteredVehicles = activeVehicles.filter((v) =>
      formFactors.includes(mapFormFactor(v.formFactor)),
    );
  }
  const vehicles = filteredVehicles.map((v) => mapVehicle(v, providerNames));

  return { stations, vehicles };
}
