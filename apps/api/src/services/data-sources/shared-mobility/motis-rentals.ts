import type { RentalFormFactor, RentalStation, RentalVehicle } from "@motis-project/motis-client";
import { rentals } from "@motis-project/motis-client";
import type { LngLat } from "@openmapx/core";
import { transitousInstance } from "../../motis/instances.js";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
  VehiclePropulsion,
} from "./types.js";

const ATTRIBUTION = { label: "Transitous", url: "https://transitous.org" };
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

function mapStation(s: RentalStation): SharedMobilityStation {
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
    operator: s.providerId,
    vehicleTypes: vehicleTypes.length > 0 ? vehicleTypes : ["other"],
    isActive: s.isRenting || s.isReturning,
    source: SOURCE,
    attribution: ATTRIBUTION,
    website: s.rentalUriWeb,
  };
}

function mapVehicle(v: RentalVehicle): SharedMobilityVehicle {
  const coordinates: LngLat = [v.lon, v.lat];

  return {
    id: `motis:${v.id}`,
    coordinates,
    formFactor: mapFormFactor(v.formFactor),
    propulsion: mapPropulsion(v.propulsionType),
    isReserved: v.isReserved,
    isDisabled: v.isDisabled,
    operator: v.providerId,
    source: SOURCE,
    attribution: ATTRIBUTION,
  };
}

export async function fetchMotisRentals(
  bbox: [number, number, number, number],
  formFactors?: VehicleFormFactor[],
): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }> {
  const [west, south, east, north] = bbox;

  const response = await rentals({
    client: transitousInstance.client,
    query: {
      min: `${south},${west}`,
      max: `${north},${east}`,
      withProviders: false,
      withStations: true,
      withVehicles: true,
    },
  });

  if (response.error || !response.data) {
    return { stations: [], vehicles: [] };
  }

  const { stations: rawStations, vehicles: rawVehicles } = response.data;

  let filteredStations = rawStations;
  if (formFactors && formFactors.length > 0) {
    filteredStations = rawStations.filter((s) =>
      s.formFactors.some((ff) => formFactors.includes(mapFormFactor(ff))),
    );
  }

  const stations = filteredStations.map(mapStation);

  const activeVehicles = rawVehicles.filter((v) => !v.isReserved && !v.isDisabled);
  let filteredVehicles = activeVehicles;
  if (formFactors && formFactors.length > 0) {
    filteredVehicles = activeVehicles.filter((v) =>
      formFactors.includes(mapFormFactor(v.formFactor)),
    );
  }
  const vehicles = filteredVehicles.map(mapVehicle);

  return { stations, vehicles };
}
