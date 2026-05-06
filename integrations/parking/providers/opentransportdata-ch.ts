import { type BoundingBox, fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "./types.js";

interface SwissParkingCapacity {
  categoryType?: string;
  total?: number;
}

interface SwissParkingPriceSegment {
  startingFrom?: number;
  price?: number;
}

interface SwissParkingFeatureProperties {
  address?: { addressLine?: string; city?: string; postalCode?: string };
  additionalInformationForCustomers?: string | null;
  bookingSystem?: string | null;
  callToAction?: Record<string, Record<string, string>>;
  capacities?: SwissParkingCapacity[];
  currentEstimatedOccupancy?: number | null;
  currentEstimatedOccupancyLevel?: "LOW" | "MEDIUM" | "HIGH" | null;
  displayName?: string;
  operationTime?: {
    daysOfWeek?: string[];
    operatingFrom?: string;
    operatingTo?: string;
  };
  operator?: string;
  parkingFacilityCategory?: "CAR" | "BIKE" | string;
  parkingFacilityType?: string;
  pricingModel?: {
    maximumDayPrice?: number | null;
    monthlyTicketPrice?: number | null;
    priceSegments?: SwissParkingPriceSegment[];
    yearlyTicketPrice?: number | null;
  };
  publicAccess?: boolean;
}

interface SwissParkingGeometryCollection {
  geometries?: Array<
    | {
        type?: "Point";
        coordinates?: [number, number];
      }
    | {
        type?: string;
        coordinates?: unknown;
      }
  >;
}

interface SwissParkingFeature {
  geometry?: SwissParkingGeometryCollection;
  id?: string;
  properties?: SwissParkingFeatureProperties;
}

interface SwissParkingFeatureCollection {
  features?: SwissParkingFeature[];
}

const DATASET_PAGE_URL = "https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking";
const FALLBACK_DOWNLOAD_URL =
  "https://data.opentransportdata.swiss/dataset/379e6847-47c0-4dcc-8d8a-f7a6a8bd809a/resource/c7bb80f4-18b1-446a-83eb-aaf4fba87944/download/bike-and-car-parking.json";
const SOURCE_ATTRIBUTION = {
  contributor: "OpenTransportData.swiss",
  license: "O-By 1.0",
  url: DATASET_PAGE_URL,
};
const CACHE_TTL_MS = 10 * 60 * 1000;
const SWISS_REDIRECT_HOSTS = ["opentransportdata.swiss", "*.opentransportdata.swiss"];

let downloadUrlCache: { expiresAt: number; url: string } | null = null;
let facilitiesCache: { expiresAt: number; facilities: ParkingFacility[] } | null = null;

function trustedSwissRedirectHosts(url: string): string[] {
  return [new URL(url).hostname, ...SWISS_REDIRECT_HOSTS];
}

function overlapsCoverage(bbox: BoundingBox): boolean {
  return bbox.south <= 47.81 && bbox.north >= 45.82 && bbox.west <= 10.49 && bbox.east >= 5.96;
}

function pickPoint(feature: SwissParkingFeature): [number, number] | null {
  const point = feature.geometry?.geometries?.find(
    (geometry): geometry is { type: "Point"; coordinates: [number, number] } =>
      geometry.type === "Point" &&
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length === 2 &&
      Number.isFinite(geometry.coordinates[0]) &&
      Number.isFinite(geometry.coordinates[1]),
  );
  return point?.coordinates ?? null;
}

function getCapacityByType(
  properties: SwissParkingFeatureProperties | undefined,
  categoryType: string,
): number | undefined {
  const match = properties?.capacities?.find((entry) => entry.categoryType === categoryType);
  return match?.total != null && Number.isFinite(match.total) ? match.total : undefined;
}

function totalCapacity(properties: SwissParkingFeatureProperties | undefined): number | undefined {
  const totals = (properties?.capacities ?? [])
    .map((entry) => entry.total)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!totals.length) return undefined;
  return totals.reduce((sum, value) => sum + value, 0);
}

function mapParkingType(properties: SwissParkingFeatureProperties | undefined): ParkingType {
  const type = properties?.parkingFacilityType ?? "";
  if (type.includes("UNDERGROUND")) return "underground";
  if (type.includes("PARK_AND_RAIL") || type === "PARKING") return "surface";
  if (type.startsWith("BIKE_")) return "surface";
  return "unknown";
}

function formatChf(cents: number | null | undefined): string | undefined {
  if (cents == null || !Number.isFinite(cents)) return undefined;
  return `CHF ${(cents / 100).toFixed(2)}`;
}

function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${minutes} min`;
}

function buildTariffRows(
  properties: SwissParkingFeatureProperties | undefined,
): [string, string][] | undefined {
  const pricing = properties?.pricingModel;
  if (!pricing) return undefined;
  const rows: [string, string][] = [];
  for (const segment of pricing.priceSegments ?? []) {
    const label = formatDuration(segment.startingFrom ?? 0);
    const price = formatChf(segment.price);
    if (price) rows.push([label, price]);
  }
  const dayPrice = formatChf(pricing.maximumDayPrice);
  if (dayPrice) rows.push(["Max day price", dayPrice]);
  const monthly = formatChf(pricing.monthlyTicketPrice);
  if (monthly) rows.push(["Monthly pass", monthly]);
  const yearly = formatChf(pricing.yearlyTicketPrice);
  if (yearly) rows.push(["Yearly pass", yearly]);
  return rows.length > 0 ? rows : undefined;
}

function operationHours(properties: SwissParkingFeatureProperties | undefined): string | undefined {
  const operation = properties?.operationTime;
  if (!operation) return undefined;
  const days = operation.daysOfWeek ?? [];
  const from = operation.operatingFrom ?? "";
  const to = operation.operatingTo ?? "";
  if (days.length === 7 && from === "00:00:00" && to === "00:00:00") return "24/7";
  if (from && to) return `${from.slice(0, 5)}-${to.slice(0, 5)}`;
  return undefined;
}

function firstActionUrl(properties: SwissParkingFeatureProperties | undefined): string | undefined {
  if (!properties?.callToAction) return undefined;
  const preferences = ["externalDesktop", "externalMobile", "sbbDesktop", "sbbMobile"];
  for (const key of preferences) {
    const entry = properties.callToAction[key];
    if (!entry) continue;
    return entry.en || entry.de || entry.fr || entry.it;
  }
  return undefined;
}

function addressLine(properties: SwissParkingFeatureProperties | undefined): string | undefined {
  const address = properties?.address;
  return (
    [address?.addressLine, address?.postalCode, address?.city].filter(Boolean).join(", ") ||
    undefined
  );
}

function featureToFacility(feature: SwissParkingFeature): ParkingFacility | null {
  const coordinates = pickPoint(feature);
  const properties = feature.properties;
  const id = feature.id;
  if (!coordinates || !properties || !id) return null;
  if (properties.parkingFacilityCategory && properties.parkingFacilityCategory !== "CAR") {
    return null;
  }

  const capacity = totalCapacity(properties);
  const occupancy = properties.currentEstimatedOccupancy;
  const freeSpaces =
    capacity != null && occupancy != null && Number.isFinite(occupancy)
      ? Math.max(0, Math.round(capacity * (1 - occupancy)))
      : undefined;
  const tariffRows = buildTariffRows(properties);
  const type = properties.parkingFacilityType ?? "";

  return {
    access: properties.publicAccess ? "public" : "private",
    address: addressLine(properties),
    capacity,
    chargingSpaces: getCapacityByType(properties, "WITH_CHARGING_STATION"),
    disabledSpaces: getCapacityByType(properties, "DISABLED_PARKING_SPACE"),
    fee:
      tariffRows && tariffRows.length > 0
        ? "paid"
        : properties.publicAccess
          ? "unknown"
          : "unknown",
    feeDescription:
      properties.additionalInformationForCustomers || properties.bookingSystem || undefined,
    freeSpaces,
    hasRealtimeData: freeSpaces !== undefined,
    id: `otdch-parking:${id}`,
    name: properties.displayName || "Parking",
    openingHours: operationHours(properties),
    operator: properties.operator || undefined,
    parkAndRide: type === "PARK_AND_RAIL",
    parkingType: mapParkingType(properties),
    paymentMethods: properties.bookingSystem || undefined,
    sources: ["opentransportdata-ch-parking"],
    sourceAttribution: SOURCE_ATTRIBUTION,
    sourceName: "OpenTransportData.swiss",
    sourceUrl: DATASET_PAGE_URL,
    state: "open",
    tariffRows,
    url: firstActionUrl(properties),
    coordinates,
  };
}

async function resolveDownloadUrl(): Promise<string> {
  if (downloadUrlCache && downloadUrlCache.expiresAt > Date.now()) {
    return downloadUrlCache.url;
  }
  try {
    const response = await fetchWithRedirects(DATASET_PAGE_URL, {
      allowedRedirectHosts: trustedSwissRedirectHosts(DATASET_PAGE_URL),
      headers: { "User-Agent": USER_AGENT },
      timeoutMs: 20_000,
    });
    if (!response.ok) throw new Error(`Dataset page failed: ${response.status}`);
    const html = await response.text();
    const href = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .filter(
        (value): value is string =>
          typeof value === "string" && value.toLowerCase().includes(".json"),
      )
      .sort((left, right) => {
        const leftScore = left.includes("/download/") ? 1 : 0;
        const rightScore = right.includes("/download/") ? 1 : 0;
        return rightScore - leftScore;
      })[0];
    if (href) {
      const url = new URL(href, DATASET_PAGE_URL).toString();
      downloadUrlCache = { expiresAt: Date.now() + CACHE_TTL_MS, url };
      return url;
    }
  } catch {
    // fall back to the last verified URL
  }
  downloadUrlCache = { expiresAt: Date.now() + CACHE_TTL_MS, url: FALLBACK_DOWNLOAD_URL };
  return FALLBACK_DOWNLOAD_URL;
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (facilitiesCache && facilitiesCache.expiresAt > Date.now()) {
    return facilitiesCache.facilities;
  }

  const url = await resolveDownloadUrl();
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: {
      "Accept-Encoding": "gzip, br, deflate",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    if (facilitiesCache) return facilitiesCache.facilities;
    throw new Error(`Swiss parking feed failed: ${response.status}`);
  }

  const collection = (await response.json()) as SwissParkingFeatureCollection;
  const facilities = (collection.features ?? [])
    .map((feature) => featureToFacility(feature))
    .filter((facility): facility is ParkingFacility => facility !== null);

  facilitiesCache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    facilities,
  };
  return facilities;
}

export async function searchOpenTransportDataChParking(
  bbox: BoundingBox,
): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];
  const facilities = await fetchAllFacilities();
  return facilities.filter((facility) => {
    const [lng, lat] = facility.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchOpenTransportDataChParkingDetail(
  id: string,
): Promise<ParkingFacility | null> {
  const facilities = await fetchAllFacilities();
  return facilities.find((facility) => facility.id === `otdch-parking:${id}`) ?? null;
}
