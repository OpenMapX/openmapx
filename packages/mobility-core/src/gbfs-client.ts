/**
 * GBFS (General Bikeshare Feed Specification) client.
 * Fetches auto-discovery feed, then individual data feeds.
 */

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
import type { MobilityHttpTransport } from "./json-transport.js";
import type {
  GbfsPricingPlan,
  GbfsStationInfo,
  GbfsStationStatus,
  GbfsSystemInfo,
  GbfsVehicleStatus,
  GbfsVehicleType,
} from "./types/shared-mobility.js";

const FETCH_TIMEOUT_MS = 8_000;
/**
 * Per-document ceiling for a single GBFS feed. The largest real feeds seen in
 * the catalog (nationwide vehicle_status documents) are a few megabytes, so
 * this leaves roughly an order of magnitude of headroom while still bounding
 * what one hostile or broken operator can make this process allocate.
 * Exceeding it drops that one feed with a warning; it never truncates a
 * document.
 */
const MAX_FEED_BYTES = 32 * 1024 * 1024;

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

/** Strip credentials and query strings out of a URL before it reaches a log. */
function scrubUrlsInMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"']+/g, (raw) => {
    try {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "[url]";
    }
  });
}

async function fetchFeedJson<T>(
  transport: MobilityHttpTransport,
  url: string,
  headers: Record<string, string> | undefined,
  allowedRedirectHosts: string[] | undefined,
): Promise<T | null> {
  try {
    const baseHeaders = { "User-Agent": transport.userAgent, Accept: "application/json" };
    return await transport.fetchJson<T>(url, {
      headers: headers ? { ...baseHeaders, ...headers } : baseHeaders,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_FEED_BYTES,
      allowPrivateHosts: transport.privateFeedHostAllowlist(),
      allowedRedirectHosts,
    });
  } catch (err) {
    console.warn(
      `[gbfs] skipped feed: ${scrubUrlsInMessage(err instanceof Error ? err.message : String(err))}`,
    );
    return null;
  }
}

/**
 * A GBFS discovery document names its own sub-feed URLs, so those hosts are
 * chosen by the remote operator, not by us. Resolve each one against the
 * discovery URL (GBFS requires absolute URLs but some feeds ship relative
 * paths) and decide separately whether it is inside the credential scope.
 */
function absolutizeFeedUrl(feedUrl: string | null, discoveryUrl: string): string | null {
  if (!feedUrl) return null;
  try {
    return new URL(feedUrl, discoveryUrl).toString();
  } catch {
    return null;
  }
}

function inCredentialScope(
  transport: MobilityHttpTransport,
  url: string,
  scope: string[],
): boolean {
  try {
    const { hostname } = new URL(url);
    return scope.some((allowed) => transport.hostMatchesAllowlist(hostname.toLowerCase(), allowed));
  } catch {
    return false;
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
 * Pass `extraHeaders` (e.g. `{ Authorization: "Bearer …" }`) for authenticated
 * feeds. Headers are only sent to hosts inside the credential scope.
 */
export interface FetchGbfsSystemOptions {
  transport: MobilityHttpTransport;
  /**
   * Hostnames (exact or "*.suffix") allowed to receive `extraHeaders`. When
   * omitted, the scope is the discovery document's own hostname. When set, it
   * is authoritative for the discovery request too — a caller whose credential
   * must never leave a known set of hosts declares that set here.
   */
  credentialHosts?: string[];
}

export async function fetchGbfsSystem(
  autoDiscoveryUrl: string,
  extraHeaders: Record<string, string> | undefined,
  options: FetchGbfsSystemOptions,
): Promise<GbfsSystemData | null> {
  const { transport } = options;
  const declaredScope = options?.credentialHosts;
  let discoveryHost = "";
  try {
    discoveryHost = new URL(autoDiscoveryUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const credentialScope = declaredScope ?? [discoveryHost];
  const redirectScope = extraHeaders ? credentialScope : undefined;

  const discoveryHeaders =
    !extraHeaders || inCredentialScope(transport, autoDiscoveryUrl, credentialScope)
      ? extraHeaders
      : undefined;

  const discovery = await fetchFeedJson<GbfsDiscoveryDocument>(
    transport,
    autoDiscoveryUrl,
    discoveryHeaders,
    redirectScope,
  );
  if (!discovery?.data) return null;

  const feedUrl = (name: string) =>
    absolutizeFeedUrl(resolveGbfsFeedUrl(discovery, name), autoDiscoveryUrl);

  const systemInfoUrl = feedUrl("system_information");
  const stationInfoUrl = feedUrl("station_information");
  const stationStatusUrl = feedUrl("station_status");
  const vehicleStatusUrl = absolutizeFeedUrl(
    resolveGbfsVehicleStatusFeedUrl(discovery),
    autoDiscoveryUrl,
  );
  const vehicleTypesUrl = feedUrl("vehicle_types");
  const pricingPlansUrl = feedUrl("system_pricing_plans");

  const subFeed = <T>(url: string | null): Promise<T | null> | null => {
    if (!url) return null;
    const headers =
      extraHeaders && inCredentialScope(transport, url, credentialScope) ? extraHeaders : undefined;
    if (extraHeaders && !headers) {
      console.warn(
        "[gbfs] discovery document pointed a sub-feed off the credential scope; fetching it unauthenticated",
      );
    }
    return fetchFeedJson<T>(transport, url, headers, headers ? redirectScope : undefined);
  };

  // Fetch all feeds in parallel
  const [sysInfoRes, stInfoRes, stStatusRes, vStatusRes, vTypesRes, pricingRes] = await Promise.all(
    [
      subFeed<GbfsSystemInformation>(systemInfoUrl),
      subFeed<GbfsStationInformation>(stationInfoUrl),
      subFeed<GbfsSystemStationStatus>(stationStatusUrl),
      subFeed<GbfsVehicleStatusDocument>(vehicleStatusUrl),
      subFeed<GbfsSystemVehicleTypes>(vehicleTypesUrl),
      subFeed<GbfsSystemPricingPlanDocument>(pricingPlansUrl),
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
