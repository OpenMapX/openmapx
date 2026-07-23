/**
 * Belgian cooperative car-sharing on the degapp / Partago platform.
 *
 * Several Flemish car-sharing cooperatives publish their fleet through the same
 * degapp JSON schema (`geoPosition`, `displayName`, `vehicleInformation`, ...).
 * This module provides one shared parser plus a static client per cooperative:
 *   - CoopStroom (app.coopstroom.be) — electric fleet, exposes `isAvailable`.
 *   - Dégage (degapp.be) — mixed fleet, no availability field (assumed available).
 *
 * Each cooperative's feed is a full fleet dump (not viewport-scoped), so we use
 * the static client factory: fetch once, cache, and filter to the viewport.
 * Every vehicle sits at a fixed home location, so we model each as a one-car
 * fixed station.
 *
 * Data-use note: these feeds are listed on the Belgian national access point
 * without an explicit reuse license (manifest `dataSources` commercialUse:
 * "unknown") — confirm terms with each cooperative before production use.
 */

import type { LngLat } from "@openmapx/core";
import type {
  SharedMobilityStation,
  VehiclePropulsion,
  VehicleTypeDetail,
} from "@openmapx/mobility-core/shared-mobility";
import { createStaticCarSharingClient } from "./static-car-sharing-client.js";

interface DegappGeoPosition {
  latitude: number;
  longitude: number;
}

interface DegappVehicleInformation {
  brand?: string;
  model?: string;
  category?: string;
  fuelType?: string;
  /** CoopStroom uses `transmissionType`; Dégage uses `type` — both are the transmission. */
  transmissionType?: string;
  type?: string;
}

interface DegappVehicle {
  geoPosition?: DegappGeoPosition;
  displayName?: string;
  stationName?: string;
  stationType?: string;
  isAvailable?: boolean;
  vehicleId?: number | string;
  vehicleInformation?: DegappVehicleInformation;
}

export interface DegappClientConfig {
  sourceId: string;
  operator: string;
}

/** Map a cooperative fuel type onto the canonical propulsion enum. */
function mapPropulsion(fuelType?: string): VehiclePropulsion | undefined {
  switch (fuelType?.toLowerCase()) {
    case "electric":
      return "electric";
    case "diesel":
      return "combustion_diesel";
    case "gasoline":
    case "petrol":
    case "cng":
    case "lpg":
      return "combustion";
    case "hybrid":
      return "hybrid";
    case "pluginhybrid":
    case "plugin_hybrid":
      return "plug_in_hybrid";
    default:
      return undefined;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function vehicleDetail(info: DegappVehicleInformation | undefined): VehicleTypeDetail | undefined {
  if (!info) return undefined;
  const make = info.brand;
  const model = info.model;
  const propulsion = mapPropulsion(info.fuelType);
  const transmission = info.transmissionType || info.type;
  const accessories = transmission ? [transmission.toLowerCase()] : undefined;
  if (!make && !model && !propulsion && !accessories) return undefined;
  return {
    name: model || make || "Car",
    formFactor: "car",
    make,
    model,
    propulsion,
    accessories,
  };
}

/** Parse a degapp fleet response body into canonical one-car fixed stations. */
export function parseDegapp(body: string, config: DegappClientConfig): SharedMobilityStation[] {
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed)) return [];

  const stations: SharedMobilityStation[] = [];
  for (const raw of parsed as DegappVehicle[]) {
    const geo = raw.geoPosition;
    if (!geo || typeof geo.latitude !== "number" || typeof geo.longitude !== "number") continue;

    // Stable native id: vehicleId when present, else a slug of the (unique) display name.
    const nativeId =
      raw.vehicleId != null && raw.vehicleId !== ""
        ? String(raw.vehicleId)
        : slugify(raw.displayName || `${geo.latitude},${geo.longitude}`);

    // CoopStroom reports availability; Dégage does not, so treat it as available.
    const available = "isAvailable" in raw ? raw.isAvailable === true : true;

    const detail = vehicleDetail(raw.vehicleInformation);
    stations.push({
      id: `${config.sourceId}/${nativeId}`,
      name: raw.stationName || raw.displayName || config.operator,
      coordinates: [geo.longitude, geo.latitude] as LngLat,
      availableVehicles: available ? 1 : 0,
      operator: config.operator,
      vehicleTypes: ["car"],
      stationType: raw.stationType === "free" ? "free" : "fixed",
      isActive: true,
      isRenting: available,
      sources: [config.sourceId],
      vehicleTypeDetails: detail ? [detail] : undefined,
    });
  }
  return stations;
}

export const beCoopstroomClient = createStaticCarSharingClient({
  id: "be-coopstroom",
  name: "CoopStroom",
  url: "https://app.coopstroom.be/api/partago/v1/fleet/coopstroom",
  regions: [{ center: [3.71, 51.11] as LngLat, radiusKm: 70 }],
  attribution: {
    label: "CoopStroom",
    url: "https://www.coopstroom.be",
    license: "Unspecified (see provider terms)",
    licenseUrl: "https://www.coopstroom.be",
  },
  parse: (body) => parseDegapp(body, { sourceId: "be-coopstroom", operator: "CoopStroom" }),
});

export const beDegageClient = createStaticCarSharingClient({
  id: "be-degage",
  name: "Dégage",
  url: "https://degapp.be/api/car/stands",
  regions: [{ center: [3.72, 51.05] as LngLat, radiusKm: 80 }],
  attribution: {
    label: "Dégage",
    url: "https://www.degage.be",
    license: "Unspecified (see provider terms)",
    licenseUrl: "https://www.degage.be",
  },
  parse: (body) => parseDegapp(body, { sourceId: "be-degage", operator: "Dégage" }),
});
