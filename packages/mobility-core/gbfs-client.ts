/**
 * GBFS (General Bikeshare Feed Specification) client.
 * Fetches auto-discovery feed, then individual data feeds.
 */

import { USER_AGENT } from "@openmapx/core";
import {
  type GbfsDiscoveryDocument,
  type GbfsV23FreeBikeStatus,
  type GbfsV23StationInformation,
  type GbfsV23StationStatus,
  type GbfsV23SystemInformation,
  type GbfsV23SystemPricingPlans,
  type GbfsV23VehicleTypes,
  type GbfsV30StationInformation,
  type GbfsV30StationStatus,
  type GbfsV30SystemInformation,
  type GbfsV30SystemPricingPlans,
  type GbfsV30VehicleStatus,
  type GbfsV30VehicleTypes,
  gbfsLocalizedTextToString,
  resolveGbfsFeedUrl,
  resolveGbfsVehicleStatusFeedUrl,
} from "@openmapx/mobility-formats";
import type {
  GbfsPricingPlan,
  GbfsStationInfo,
  GbfsStationStatus,
  GbfsSystemInfo,
  GbfsVehicleStatus,
  GbfsVehicleType,
} from "./types.js";

const FETCH_TIMEOUT_MS = 8_000;
const BASE_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "application/json",
};

type RawStationStatus =
  | GbfsV23StationStatus["data"]["stations"][number]
  | GbfsV30StationStatus["data"]["stations"][number];
type RawVehicleStatus =
  | GbfsV23FreeBikeStatus["data"]["bikes"][number]
  | GbfsV30VehicleStatus["data"]["vehicles"][number];
type GbfsSystemInformation = GbfsV23SystemInformation | GbfsV30SystemInformation;
type GbfsStationInformation = GbfsV23StationInformation | GbfsV30StationInformation;
type GbfsSystemStationStatus = GbfsV23StationStatus | GbfsV30StationStatus;
type GbfsVehicleStatusDocument = GbfsV23FreeBikeStatus | GbfsV30VehicleStatus;
type GbfsSystemVehicleTypes = GbfsV23VehicleTypes | GbfsV30VehicleTypes;
type GbfsSystemPricingPlanDocument = GbfsV23SystemPricingPlans | GbfsV30SystemPricingPlans;

async function fetchJson<T>(url: string, extraHeaders?: Record<string, string>): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const headers = extraHeaders ? { ...BASE_HEADERS, ...extraHeaders } : BASE_HEADERS;
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getStationAvailabilityCount(status: RawStationStatus): number {
  return "num_bikes_available" in status
    ? (status.num_bikes_available ?? 0)
    : (status.num_vehicles_available ?? 0);
}

function getRawVehicleStatuses(document: GbfsVehicleStatusDocument | null): RawVehicleStatus[] {
  if (!document?.data) return [];
  if ("vehicles" in document.data && Array.isArray(document.data.vehicles)) {
    return document.data.vehicles;
  }
  if ("bikes" in document.data && Array.isArray(document.data.bikes)) {
    return document.data.bikes;
  }
  return [];
}

export interface GbfsSystemData {
  systemInfo: GbfsSystemInfo | null;
  stations: GbfsStationInfo[];
  stationStatuses: Map<string, GbfsStationStatus>;
  vehicles: GbfsVehicleStatus[];
  vehicleTypes: Map<string, GbfsVehicleType>;
  pricingPlans: Map<string, GbfsPricingPlan>;
}

/**
 * Fetches all relevant GBFS feeds for a system given its auto-discovery URL.
 * Pass `extraHeaders` (e.g. `{ Authorization: "Bearer …" }`) for authenticated feeds.
 */
export async function fetchGbfsSystem(
  autoDiscoveryUrl: string,
  extraHeaders?: Record<string, string>,
): Promise<GbfsSystemData | null> {
  const discovery = await fetchJson<GbfsDiscoveryDocument>(autoDiscoveryUrl, extraHeaders);
  if (!discovery?.data) return null;

  const systemInfoUrl = resolveGbfsFeedUrl(discovery, "system_information");
  const stationInfoUrl = resolveGbfsFeedUrl(discovery, "station_information");
  const stationStatusUrl = resolveGbfsFeedUrl(discovery, "station_status");
  const vehicleStatusUrl = resolveGbfsVehicleStatusFeedUrl(discovery);
  const vehicleTypesUrl = resolveGbfsFeedUrl(discovery, "vehicle_types");
  const pricingPlansUrl = resolveGbfsFeedUrl(discovery, "system_pricing_plans");

  // Fetch all feeds in parallel
  const [sysInfoRes, stInfoRes, stStatusRes, vStatusRes, vTypesRes, pricingRes] = await Promise.all(
    [
      systemInfoUrl ? fetchJson<GbfsSystemInformation>(systemInfoUrl, extraHeaders) : null,
      stationInfoUrl ? fetchJson<GbfsStationInformation>(stationInfoUrl, extraHeaders) : null,
      stationStatusUrl ? fetchJson<GbfsSystemStationStatus>(stationStatusUrl, extraHeaders) : null,
      vehicleStatusUrl
        ? fetchJson<GbfsVehicleStatusDocument>(vehicleStatusUrl, extraHeaders)
        : null,
      vehicleTypesUrl ? fetchJson<GbfsSystemVehicleTypes>(vehicleTypesUrl, extraHeaders) : null,
      pricingPlansUrl
        ? fetchJson<GbfsSystemPricingPlanDocument>(pricingPlansUrl, extraHeaders)
        : null,
    ],
  );

  const systemInfo: GbfsSystemInfo | null = sysInfoRes?.data
    ? {
        systemId: sysInfoRes.data.system_id,
        name: gbfsLocalizedTextToString(sysInfoRes.data.name),
        operator: sysInfoRes.data.operator
          ? gbfsLocalizedTextToString(sysInfoRes.data.operator)
          : undefined,
        url: sysInfoRes.data.url,
        timezone: sysInfoRes.data.timezone,
        openingHours:
          "opening_hours" in sysInfoRes.data ? sysInfoRes.data.opening_hours : undefined,
      }
    : null;

  const stations: GbfsStationInfo[] = (stInfoRes?.data?.stations ?? []).map((s) => ({
    stationId: s.station_id,
    name: gbfsLocalizedTextToString(s.name),
    lat: s.lat,
    lon: s.lon,
    capacity: s.capacity,
    vehicleTypesAvailable:
      "vehicle_types_available" in s
        ? s.vehicle_types_available?.map((v: { vehicle_type_id: string }) => v.vehicle_type_id)
        : undefined,
    rentalUris: s.rental_uris,
  }));

  const stationStatuses = new Map<string, GbfsStationStatus>();
  for (const s of stStatusRes?.data?.stations ?? []) {
    stationStatuses.set(s.station_id, {
      stationId: s.station_id,
      numBikesAvailable: getStationAvailabilityCount(s),
      numDocksAvailable: s.num_docks_available,
      isInstalled: s.is_installed ?? true,
      isRenting: s.is_renting ?? true,
      isReturning: s.is_returning ?? true,
      vehicleTypesAvailable: s.vehicle_types_available?.map((v) => ({
        vehicleTypeId: v.vehicle_type_id,
        count: v.count,
      })),
    });
  }

  const rawVehicles = getRawVehicleStatuses(vStatusRes);
  const vehicles: GbfsVehicleStatus[] = rawVehicles
    .filter((v) => v.bike_id || v.vehicle_id)
    .map((v) => ({
      bikeId: (v.bike_id ?? v.vehicle_id) as string,
      lat: v.lat,
      lon: v.lon,
      isReserved: v.is_reserved ?? false,
      isDisabled: v.is_disabled ?? false,
      vehicleTypeId: v.vehicle_type_id,
      currentRangeMeters: v.current_range_meters,
      currentFuelPercent: v.current_fuel_percent,
      stationId: v.station_id,
    }));

  const vehicleTypes = new Map<string, GbfsVehicleType>();
  for (const vt of vTypesRes?.data?.vehicle_types ?? []) {
    vehicleTypes.set(vt.vehicle_type_id, {
      vehicleTypeId: vt.vehicle_type_id,
      formFactor: vt.form_factor ?? "bicycle",
      propulsionType: vt.propulsion_type ?? "human",
      name: gbfsLocalizedTextToString(vt.name),
      maxRangeMeters: vt.max_range_meters,
      make: vt.make ? gbfsLocalizedTextToString(vt.make) : undefined,
      model: vt.model ? gbfsLocalizedTextToString(vt.model) : undefined,
      riderCapacity: vt.rider_capacity,
      vehicleAccessories: vt.vehicle_accessories?.map((a) => gbfsLocalizedTextToString(a)),
      co2PerKm: vt.g_CO2_km,
      returnConstraint: vt.return_constraint,
      defaultPricingPlanId: vt.default_pricing_plan_id,
      pricingPlanIds: vt.pricing_plan_ids,
    });
  }

  const pricingPlans = new Map<string, GbfsPricingPlan>();
  for (const pp of pricingRes?.data?.plans ?? []) {
    pricingPlans.set(pp.plan_id, {
      planId: pp.plan_id,
      name: gbfsLocalizedTextToString(pp.name),
      currency: pp.currency ?? "EUR",
      price: pp.price ?? 0,
      isTaxable: pp.is_taxable ?? false,
      description: pp.description ? gbfsLocalizedTextToString(pp.description) : undefined,
      perKmPricing: pp.per_km_pricing,
      perMinPricing: pp.per_min_pricing,
    });
  }

  return { systemInfo, stations, stationStatuses, vehicles, vehicleTypes, pricingPlans };
}
