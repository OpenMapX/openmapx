import { type BoundingBox, fetchJson } from "@openmapx/core";
import type {
  EvChargingSource,
  EvChargingStation,
  EvChargingStatus,
  EvseAvailability,
} from "@openmapx/mobility-core/ev-charging";
import { getEvChargingSourcePriority } from "./source-priority.js";
import {
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  isSafeHttpUrl,
  parseLocalizedNumber,
} from "./utils.js";

/**
 * LTA DataMall `EVChargingPoints` / `EVCBatch` response shapes, per the
 * official API User Guide (v6.8, 21 Apr 2026), section 2.28/2.29. Field
 * names — including the provider's own `longtitude` typo — are kept as
 * documented.
 */
interface SgLtaEvId {
  /** Duplicates `evCpId` per the docs ("Refer to evCpId"). */
  id?: string;
  /** Connector id, e.g. `R123456A-001`. */
  evCpId?: string;
  /** `"1"` available, `"0"` occupied, `""` not available. */
  status?: string | number;
}

interface SgLtaPlugType {
  plugType?: string;
  /** Documented as AC/DC despite the "powerRating" name. */
  powerRating?: string;
  /** kW. */
  chargingSpeed?: number | string;
  price?: number | string;
  priceType?: string;
}

interface SgLtaChargingPoint {
  /** `"1"` available, `"0"` occupied, `"100"` not available. */
  status?: string | number;
  operationHours?: string;
  operator?: string;
  position?: string;
  name?: string;
  id?: string;
  plugTypes?: SgLtaPlugType[];
  evIds?: SgLtaEvId[];
}

interface SgLtaStation {
  address?: string;
  name?: string;
  longtitude?: number | string;
  latitude?: number | string;
  /** Stable id: first 6 decimal places of longitude + the 6-digit postal code. */
  locationId?: string;
  status?: string | number;
  chargingPoints?: SgLtaChargingPoint[];
}

interface SgLtaBatchLinkResponse {
  value?: Array<{ Link?: string }>;
}

interface SgLtaStationsResponse {
  value?: SgLtaStation[];
}

const EVC_BATCH_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVCBatch";
const EVC_POSTAL_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVChargingPoints";
const DATASET_URL = "https://datamall.lta.gov.sg/content/datamall/en/dynamic-data.html";
// [west, south, east, north] — Singapore mainland + islands.
const COVERAGE = { south: 1.15, west: 103.6, north: 1.48, east: 104.1 };
const STATION_PREFIX = "sg-ltadatamall:";
// Singapore postal codes are always 6 digits, and `locationId` is documented
// as "first 6 decimal places of longitude followed by postal code" — so the
// last 6 characters recover the postal code needed for a single-station
// detail lookup.
const POSTAL_CODE_LENGTH = 6;

let sgLtaDatamallApiKey: string | undefined;

export function setSgLtaDatamallApiKey(value: string | undefined): void {
  sgLtaDatamallApiKey = value && value.length > 0 ? value : undefined;
}

function authHeaders(): Record<string, string> {
  return { AccountKey: sgLtaDatamallApiKey as string };
}

function postalCodeFromLocationId(locationId: string): string | undefined {
  if (locationId.length < POSTAL_CODE_LENGTH) return undefined;
  return locationId.slice(-POSTAL_CODE_LENGTH);
}

function stationStatus(station: SgLtaStation): EvChargingStatus {
  const raw = String(station.status ?? "").trim();
  // "0" (occupied) and "1" (available) both mean the station is working —
  // only "100" (not available) means the whole station is down.
  if (raw === "1" || raw === "0") return "operational";
  if (raw === "100") return "not-operational";
  return "unknown";
}

function collectEvIds(station: SgLtaStation): SgLtaEvId[] {
  return (station.chargingPoints ?? []).flatMap((point) => point.evIds ?? []);
}

function stationAvailability(station: SgLtaStation): EvseAvailability | undefined {
  const evIds = collectEvIds(station);
  if (evIds.length === 0) return undefined;
  const available = evIds.filter((evId) => String(evId.status ?? "").trim() === "1").length;
  return { available, total: evIds.length, updatedAt: new Date().toISOString() };
}

function stationOperator(station: SgLtaStation): string | undefined {
  for (const point of station.chargingPoints ?? []) {
    const name = cleanString(point.operator);
    if (name) return name;
  }
  return undefined;
}

function usageCostSummary(station: SgLtaStation): string | undefined {
  const parts: string[] = [];
  for (const point of station.chargingPoints ?? []) {
    for (const plug of point.plugTypes ?? []) {
      const price = parseLocalizedNumber(plug.price);
      if (price === undefined) continue;
      const unit = cleanString(String(plug.priceType ?? ""));
      parts.push(unit ? `${price}/${unit}` : String(price));
    }
  }
  return parts.length > 0 ? Array.from(new Set(parts)).join(", ") : undefined;
}

function buildConnectors(station: SgLtaStation): EvChargingStation["connectors"] {
  const connectors: EvChargingStation["connectors"] = [];
  for (const point of station.chargingPoints ?? []) {
    const quantity = (point.evIds ?? []).length || undefined;
    for (const plug of point.plugTypes ?? []) {
      connectors.push(
        connector({
          type: plug.plugType,
          powerKw: parseLocalizedNumber(plug.chargingSpeed),
          currentType: cleanString(String(plug.powerRating ?? "")),
          quantity,
        }),
      );
    }
  }
  return connectors;
}

function stationToCanonical(station: SgLtaStation): EvChargingStation | null {
  const id = cleanString(station.locationId);
  const lat = parseLocalizedNumber(station.latitude);
  const lng = parseLocalizedNumber(station.longtitude);
  if (!id || lat === undefined || lng === undefined) return null;

  const operatorName = stationOperator(station);

  return {
    id: `${STATION_PREFIX}${id}`,
    sources: ["sg-ltadatamall"],
    sourceItemIds: [`${STATION_PREFIX}${id}`],
    name: cleanString(station.name) ?? "EV Charging Station",
    coordinates: [lng, lat],
    address: {
      line1: cleanString(station.address),
      postcode: postalCodeFromLocationId(id),
      country: "Singapore",
    },
    operator: operatorName ? { name: operatorName } : undefined,
    status: stationStatus(station),
    availability: stationAvailability(station),
    isLive: true,
    usageType: "Public",
    usageCost: usageCostSummary(station),
    openingHours: cleanString(station.chargingPoints?.[0]?.operationHours),
    connectors: buildConnectors(station),
    updatedAt: new Date().toISOString(),
    sourceUrl: DATASET_URL,
  };
}

async function fetchBatchStations(): Promise<SgLtaStation[]> {
  const linkResponse = await fetchJson<SgLtaBatchLinkResponse>(EVC_BATCH_URL, {
    headers: authHeaders(),
    errorMessage: ({ status }) => `LTA DataMall EVCBatch error: ${status}`,
  });
  const link = linkResponse.value?.[0]?.Link;
  if (!isSafeHttpUrl(link)) return [];
  // The batch link is a pre-signed S3 URL — no AccountKey needed for it.
  const batch = await fetchJson<SgLtaStationsResponse | SgLtaStation[]>(link, {
    errorMessage: ({ status }) => `LTA DataMall EV batch file error: ${status}`,
  });
  return Array.isArray(batch) ? batch : (batch.value ?? []);
}

export async function searchSgLtaDatamallCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!sgLtaDatamallApiKey || !bboxOverlaps(bbox, COVERAGE)) return [];
  const stations = await fetchBatchStations();
  return stations
    .map(stationToCanonical)
    .filter((station): station is EvChargingStation => Boolean(station))
    .filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

export async function fetchSgLtaDatamallChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  if (!sgLtaDatamallApiKey) return null;
  const locationId = itemId.startsWith(STATION_PREFIX)
    ? itemId.slice(STATION_PREFIX.length)
    : itemId;
  const postalCode = postalCodeFromLocationId(locationId);
  if (!postalCode) return null;

  const params = new URLSearchParams({ PostalCode: postalCode });
  const data = await fetchJson<SgLtaStationsResponse>(`${EVC_POSTAL_URL}?${params.toString()}`, {
    headers: authHeaders(),
    errorMessage: ({ status }) => `LTA DataMall EVChargingPoints error: ${status}`,
  });
  const match = (data.value ?? []).find(
    (station) => cleanString(station.locationId) === locationId,
  );
  return match ? stationToCanonical(match) : null;
}

export const sgLtaDatamallSource: EvChargingSource = {
  id: "sg-ltadatamall",
  priority: getEvChargingSourcePriority("sg-ltadatamall"),
  search: searchSgLtaDatamallCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_PREFIX),
  fetchDetail: fetchSgLtaDatamallChargingDetail,
};
