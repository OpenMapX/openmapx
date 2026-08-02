import { fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import { hostMatchesAllowlist } from "@openmapx/core/utils/safe-download";
import { token } from "@openmapx/integration-framework/strings";
import type { I18nTokenLike, ParkingType } from "@openmapx/mobility-core/parking";
import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Bundled parser for OpenTransportData.swiss bike-and-car-parking.
 *
 * The dataset is published via a HTML landing page that points to a
 * versioned JSON download. We use `resolveUrl` (see this file's
 * `resolveChOtdDownloadUrl` export, registered in
 * poi-sources.ts) so data-manager scrapes the page itself; the parser only
 * deals with the JSON FeatureCollection.
 *
 * The feed carries `currentEstimatedOccupancy` per facility, which the
 * pre-migration impl projected to a derived `freeSpaces`. We keep the same
 * derivation here and emit it through the live tier so the API surface
 * gets a `realtimeDataUpdatedAt` tag — matching `parkapi-v3`'s pattern.
 */

const DATASET_PAGE_URL = "https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking";
const FALLBACK_DOWNLOAD_URL =
  "https://data.opentransportdata.swiss/dataset/379e6847-47c0-4dcc-8d8a-f7a6a8bd809a/resource/4d05c390-b87c-42fe-9b3f-8767dd2dedd8/download/bike-and-car-parking.json";
const SWISS_REDIRECT_HOSTS = [
  "opentransportdata.swiss",
  "*.opentransportdata.swiss",
  "83025b28472d6aa2bf5ae59f3724aa78.eu.r2.cloudflarestorage.com",
];

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

interface SwissParkingFeature {
  geometry?: {
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
  };
  id?: string;
  properties?: SwissParkingFeatureProperties;
}

interface SwissParkingFeatureCollection {
  features?: SwissParkingFeature[];
}

function trustedSwissRedirectHosts(url: string): string[] {
  return [new URL(url).hostname, ...SWISS_REDIRECT_HOSTS];
}

/**
 * Scrapes the OpenTransportData.swiss dataset landing page for the latest
 * JSON download URL, falling back to a hard-coded resource URL if the page
 * is unavailable or no link can be parsed. Wired into PoiSource.bundled.resolveUrl.
 */
export async function resolveChOtdDownloadUrl(log: PoiSourceLogger): Promise<string> {
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
      const resolved = new URL(href, DATASET_PAGE_URL);
      // An absolute href on the scraped page would otherwise replace the base
      // entirely, letting page content pick the download host.
      const allowed = trustedSwissRedirectHosts(DATASET_PAGE_URL);
      if (
        (resolved.protocol === "https:" || resolved.protocol === "http:") &&
        allowed.some((host) => hostMatchesAllowlist(resolved.hostname, host))
      ) {
        return resolved.toString();
      }
      log.warn("opentransportdata-ch: scraped download URL host is not trusted — using fallback");
    }
    log.warn("opentransportdata-ch: dataset page contained no JSON URL — using fallback");
  } catch (err) {
    log.warn(`opentransportdata-ch: scrape failed (${(err as Error).message}) — using fallback`);
  }
  return FALLBACK_DOWNLOAD_URL;
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

function durationToken(minutes: number): I18nTokenLike {
  if (minutes % 1440 === 0) {
    return token("tariff.durDays", { count: minutes / 1440 });
  }
  if (minutes % 60 === 0) {
    return token("tariff.durHours", { count: minutes / 60 });
  }
  return token("tariff.durMinutes", { count: minutes });
}

function buildTariffRows(
  properties: SwissParkingFeatureProperties | undefined,
): [I18nTokenLike, string][] | undefined {
  const pricing = properties?.pricingModel;
  if (!pricing) return undefined;
  const rows: [I18nTokenLike, string][] = [];
  for (const segment of pricing.priceSegments ?? []) {
    const label = durationToken(segment.startingFrom ?? 0);
    const price = formatChf(segment.price);
    if (price) rows.push([label, price]);
  }
  const dayPrice = formatChf(pricing.maximumDayPrice);
  if (dayPrice) rows.push([token("tariff.maxDayPrice"), dayPrice]);
  const monthly = formatChf(pricing.monthlyTicketPrice);
  if (monthly) rows.push([token("tariff.monthlyPass"), monthly]);
  const yearly = formatChf(pricing.yearlyTicketPrice);
  if (yearly) rows.push([token("tariff.yearlyPass"), yearly]);
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

export const parseChOtdBundled: PoiBundledParseFn = (buffer, { log }) => {
  let collection: SwissParkingFeatureCollection;
  try {
    collection = JSON.parse(buffer.toString("utf-8")) as SwissParkingFeatureCollection;
  } catch (err) {
    log.warn("opentransportdata-ch: failed to parse feed JSON", { error: (err as Error).message });
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  const now = new Date().toISOString();

  for (const feature of collection.features ?? []) {
    const coordinates = pickPoint(feature);
    const properties = feature.properties;
    const id = feature.id;
    if (!coordinates || !properties || !id) continue;
    if (properties.parkingFacilityCategory && properties.parkingFacilityCategory !== "CAR") {
      continue;
    }

    const capacity = totalCapacity(properties);
    const occupancy = properties.currentEstimatedOccupancy;
    const freeSpaces =
      capacity != null && occupancy != null && Number.isFinite(occupancy)
        ? Math.max(0, Math.round(capacity * (1 - occupancy)))
        : undefined;
    const tariffRows = buildTariffRows(properties);
    const type = properties.parkingFacilityType ?? "";

    staticRows.push({
      poiId: id,
      lng: coordinates[0],
      lat: coordinates[1],
      payload: {
        coordinates,
        name: properties.displayName || "Parking",
        parkingType: mapParkingType(properties),
        capacity,
        chargingSpaces: getCapacityByType(properties, "WITH_CHARGING_STATION"),
        disabledSpaces: getCapacityByType(properties, "DISABLED_PARKING_SPACE"),
        access: properties.publicAccess ? "public" : "private",
        address: addressLine(properties),
        fee:
          tariffRows && tariffRows.length > 0
            ? "paid"
            : properties.publicAccess
              ? "unknown"
              : "unknown",
        feeDescription:
          properties.additionalInformationForCustomers || properties.bookingSystem || undefined,
        openingHours: operationHours(properties),
        operator: properties.operator || undefined,
        parkAndRide: type === "PARK_AND_RAIL",
        paymentMethods: properties.bookingSystem || undefined,
        tariffRows,
        url: firstActionUrl(properties),
      },
    });

    if (freeSpaces !== undefined) {
      live.set(id, {
        asOf: now,
        freeSpaces,
        capacity: capacity ?? null,
      });
    }
  }

  return { static: staticRows, live };
};
