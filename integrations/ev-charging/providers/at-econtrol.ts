/**
 * E-Control Austria — Ladestellenverzeichnis (national EV charging directory).
 *
 * The public API (https://www.ladestellen.at, admin at
 * https://admin.ladestellen.at/#/api/registrieren) exposes a single
 * `GET /search?latitude=&longitude=` endpoint that returns the nearest public
 * charging stations to a point, INCLUDING live per-EVSE status
 * (AVAILABLE/CHARGING/OCCUPIED/OUTOFORDER/…) and structured ad-hoc pricing —
 * no separate live-status or detail call exists. Auth is two-part: an
 * `Apikey` header AND a `Referer: https://<registered-domain>` header, where
 * `<registered-domain>` is the bare hostname the operator registered at
 * signup (the gateway 403s on a Referer/registration mismatch). Both values
 * are required — this provider is INERT (returns []) until an operator
 * configures both.
 *
 * The endpoint takes no bbox/radius parameter — it always returns the
 * server's own idea of "nearest" stations to the queried point, so wide
 * viewports far from the queried center may see fewer results near their
 * edges than a true bbox query would. We query the bbox center and filter
 * the response back down to the requested bbox.
 *
 * Field names (station/point shape, `Apikey`/`Referer` headers, the
 * `/search` path, and the two-part auth contract) are corroborated by the
 * MIT-licensed Home Assistant integration
 * https://github.com/rolandzeiner/ladestellen-austria (const.py, coordinator.py,
 * src/types.ts), which documents them as reverse-engineered against the live
 * API — E-Control's own Swagger docs
 * (https://api.e-control.at/charge/1.0/swagger-ui.html?urls.primaryName=public-api)
 * are only reachable with a registered API key, so this mapping is
 * INFERRED FROM THIRD-PARTY DOCS and has not been validated against a live
 * response from E-Control itself.
 */

import { type BoundingBox, fetchJson } from "@openmapx/core";
import type {
  EvChargingConnector,
  EvChargingPriceComponent,
  EvChargingSource,
  EvChargingStation,
  EvChargingStatus,
  EvChargingTariff,
} from "@openmapx/mobility-core/ev-charging";
import { getEvChargingSourcePriority } from "./source-priority.js";
import {
  bboxCenter,
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  isSafeHttpUrl,
  uniqueStrings,
} from "./utils.js";

interface AtEcontrolConnectorType {
  key?: string;
  consumerName?: string;
}

interface AtEcontrolOpeningHours {
  fromWeekday?: string;
  fromTime?: string;
  toWeekday?: string;
  toTime?: string;
}

interface AtEcontrolPoint {
  evseId?: string;
  capacityKw?: number;
  connectorType?: AtEcontrolConnectorType[];
  electricityType?: string[];
  status?: string;
  freeOfCharge?: boolean;
  priceCentKwh?: number;
  priceCentMin?: number;
  startFeeCent?: number;
  blockingFeeCentMin?: number;
  blockingFeeFromMinute?: number;
  authenticationMode?: string[];
}

interface AtEcontrolStation {
  stationId?: string;
  label?: string;
  description?: string | null;
  operatorName?: string;
  owner?: string;
  stationStatus?: string;
  postCode?: string;
  city?: string;
  street?: string;
  location?: { lat?: number; lon?: number };
  website?: string | null;
  greenEnergy?: boolean;
  austrianEcoLabel?: boolean;
  freeParking?: boolean;
  parkingPlaces?: number;
  barrierFreeParkingPlaces?: number;
  openingHours?: AtEcontrolOpeningHours[];
  points?: AtEcontrolPoint[];
}

const SOURCE_ID = "at-econtrol";
const API_URL = "https://api.e-control.at/charge/1.0/search";
const SOURCE_URL = "https://www.ladestellen.at";
const STATION_PREFIX = "at-econtrol:";
// [west, south, east, north]
const COVERAGE = { south: 46.3, west: 9.5, north: 49.1, east: 17.2 };

let atEcontrolApiKey: string | undefined;
let atEcontrolRefererDomain: string | undefined;

export function setAtEcontrolApiKey(value: string | undefined): void {
  atEcontrolApiKey = value && value.length > 0 ? value : undefined;
}

/**
 * The `Referer` header's hostname must match the domain the operator
 * registered at https://admin.ladestellen.at/#/api/registrieren (bare
 * hostname, no scheme/port/path) or the gateway 403s. Set alongside the API
 * key; both are required before this source activates.
 */
export function setAtEcontrolRefererDomain(value: string | undefined): void {
  atEcontrolRefererDomain = value && value.length > 0 ? value : undefined;
}

function credentialsReady(): boolean {
  return Boolean(atEcontrolApiKey && atEcontrolRefererDomain);
}

function authHeaders(): Record<string, string> {
  return {
    Apikey: atEcontrolApiKey as string,
    Referer: `https://${atEcontrolRefererDomain}`,
  };
}

/**
 * Maps the API's `connectorType[].consumerName` (+ `key` fallback for
 * `OTHER`) to our display labels. Mirrors de-ocpdb-parser's
 * `mapConnectorStandard` naming convention for the same physical connector
 * families.
 */
function connectorLabel(consumerName: string | undefined, key: string | undefined): string {
  switch (consumerName) {
    case "TYPE_2_AC":
      return "Type 2";
    case "COMBO2_CCS_DC":
      return "CCS (Type 2)";
    case "CHADEMO":
      return "CHAdeMO";
    case "TYPE_1_AC":
      return "Type 1";
    case "TESLA_S":
    case "TESLA_R":
      return "Tesla";
    case "OTHER":
      if (key === "DOMESTIC_F") return "Schuko";
      return "Unknown";
    default:
      return "Unknown";
  }
}

function pointCurrentType(point: AtEcontrolPoint): "AC" | "DC" | undefined {
  const types = point.electricityType ?? [];
  if (types.some((t) => t?.toUpperCase().startsWith("DC"))) return "DC";
  if (types.some((t) => t?.toUpperCase().startsWith("AC"))) return "AC";
  return undefined;
}

function pointConnectors(point: AtEcontrolPoint): EvChargingConnector[] {
  const currentType = pointCurrentType(point);
  const status = cleanString(point.status);
  const types = point.connectorType ?? [];
  if (types.length === 0) {
    return [
      connector({ type: "Unknown", powerKw: point.capacityKw, currentType, quantity: 1, status }),
    ];
  }
  return types.map((ct) =>
    connector({
      type: connectorLabel(ct.consumerName, ct.key),
      powerKw: point.capacityKw,
      currentType,
      quantity: 1,
      status,
    }),
  );
}

function centsToEur(cents: number | undefined): number | undefined {
  return typeof cents === "number" && Number.isFinite(cents) && cents > 0
    ? Math.round(cents) / 100
    : undefined;
}

/**
 * Maps a single point's structured ad-hoc pricing fields to
 * {@link EvChargingTariff}s, scoped "evse" (the API prices per charge point,
 * not per station or per CPO). The base energy/time/flat components share no
 * restriction and form one tariff; a `blockingFeeCentMin` that only applies
 * past `blockingFeeFromMinute` gets its own tariff carrying that
 * `minDurationMinutes` restriction — `EvChargingTariff.restrictions` is one
 * set per tariff, so a differently-restricted component can't share the base
 * tariff (same split-by-restriction approach as `splitOcpiTariffElements`).
 */
function pointTariffs(point: AtEcontrolPoint, updatedAt: string): EvChargingTariff[] {
  if (point.freeOfCharge) return [];

  const elements: EvChargingPriceComponent[] = [];
  const energy = centsToEur(point.priceCentKwh);
  if (energy !== undefined) elements.push({ type: "energy", price: energy, currency: "EUR" });
  const time = centsToEur(point.priceCentMin);
  if (time !== undefined) elements.push({ type: "time", price: time, currency: "EUR" });
  const flat = centsToEur(point.startFeeCent);
  if (flat !== undefined) elements.push({ type: "flat", price: flat, currency: "EUR" });

  const tariffs: EvChargingTariff[] = [];
  if (elements.length > 0) {
    tariffs.push({ elements, scope: "evse", source: SOURCE_ID, sourceUrl: SOURCE_URL, updatedAt });
  }

  const blockingPrice = centsToEur(point.blockingFeeCentMin);
  if (
    blockingPrice !== undefined &&
    point.blockingFeeFromMinute &&
    point.blockingFeeFromMinute > 0
  ) {
    tariffs.push({
      elements: [{ type: "time", price: blockingPrice, currency: "EUR" }],
      restrictions: { minDurationMinutes: point.blockingFeeFromMinute },
      scope: "evse",
      source: SOURCE_ID,
      sourceUrl: SOURCE_URL,
      altText: "Blocking fee applied after the free grace period",
      updatedAt,
    });
  }
  return tariffs;
}

function stationStatusFrom(raw: string | undefined): EvChargingStatus {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "ACTIVE") return "operational";
  if (upper === "PLANNED") return "planned";
  if (["INACTIVE", "REMOVED", "DEACTIVATED", "DECOMMISSIONED"].includes(upper)) {
    return "not-operational";
  }
  return "unknown";
}

function formatOpeningHours(entries: AtEcontrolOpeningHours[] | undefined): string | undefined {
  if (!entries || entries.length === 0) return undefined;
  const parts = entries
    .map((e) => {
      const from = cleanString(e.fromWeekday);
      const fromTime = cleanString(e.fromTime);
      const to = cleanString(e.toWeekday);
      const toTime = cleanString(e.toTime);
      if (!from || !fromTime || !to || !toTime) return undefined;
      const spansFullWeek = from === to || (from === "MONDAY" && to === "SUNDAY");
      if (spansFullWeek && fromTime === "00:00" && (toTime === "24:00" || toTime === "23:59")) {
        return "24/7";
      }
      return `${from} ${fromTime}–${to} ${toTime}`;
    })
    .filter((v): v is string => Boolean(v));
  return parts.length > 0 ? Array.from(new Set(parts)).join("; ") : undefined;
}

function stationNotes(station: AtEcontrolStation): string[] | undefined {
  const notes: string[] = [];
  if (station.greenEnergy) notes.push("Green energy");
  if (station.austrianEcoLabel) notes.push("Austrian Ecolabel certified");
  if (station.freeParking) notes.push("Free parking");
  if (typeof station.parkingPlaces === "number" && station.parkingPlaces > 0) {
    notes.push(`Parking places: ${station.parkingPlaces}`);
  }
  const description = cleanString(station.description ?? undefined);
  if (description) notes.push(description);
  return notes.length > 0 ? notes : undefined;
}

function stationToCanonical(station: AtEcontrolStation): EvChargingStation | null {
  const id = cleanString(station.stationId);
  const lat = station.location?.lat;
  const lng = station.location?.lon;
  if (
    !id ||
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  const updatedAt = new Date().toISOString();
  const points = station.points ?? [];
  const connectors = points.flatMap((point) => pointConnectors(point));
  const tariffs = points.flatMap((point) => pointTariffs(point, updatedAt));
  const paymentMethods = uniqueStrings(points.map((point) => point.authenticationMode));
  const operatorName = cleanString(station.operatorName ?? station.owner);
  const website = station.website ?? undefined;

  return {
    id: `${STATION_PREFIX}${id}`,
    sources: [SOURCE_ID],
    sourceItemIds: [`${STATION_PREFIX}${id}`],
    name: cleanString(station.label) ?? "EV Charging Station",
    coordinates: [lng, lat],
    address: {
      line1: cleanString(station.street),
      town: cleanString(station.city),
      postcode: cleanString(station.postCode),
      country: "Austria",
    },
    operator: operatorName
      ? { name: operatorName, url: isSafeHttpUrl(website) ? website : undefined }
      : undefined,
    status: stationStatusFrom(station.stationStatus),
    isLive: true,
    usageType: "Public",
    openingHours: formatOpeningHours(station.openingHours),
    access:
      typeof station.barrierFreeParkingPlaces === "number" && station.barrierFreeParkingPlaces > 0
        ? "Barrier-free parking available"
        : undefined,
    paymentMethods,
    connectors,
    tariffs: tariffs.length > 0 ? tariffs : undefined,
    updatedAt,
    sourceUrl: SOURCE_URL,
    notes: stationNotes(station),
  };
}

export async function searchAtEcontrolCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!credentialsReady() || !bboxOverlaps(bbox, COVERAGE)) return [];
  const [lng, lat] = bboxCenter(bbox);
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
  });

  const stations = await fetchJson<AtEcontrolStation[]>(`${API_URL}?${params.toString()}`, {
    headers: authHeaders(),
    errorMessage: ({ status }) => `E-Control Ladestellenverzeichnis API error: ${status}`,
  });
  if (!Array.isArray(stations)) return [];

  return stations
    .map(stationToCanonical)
    .filter((station): station is EvChargingStation => Boolean(station))
    .filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

// E-Control's public API exposes only `/search` (nearest-to-point) — there is
// no documented single-station detail endpoint, so this source has no
// canFetchDetail/fetchDetail; the full station record is already returned by
// search.
export const atEcontrolSource: EvChargingSource = {
  id: SOURCE_ID,
  priority: getEvChargingSourcePriority(SOURCE_ID),
  search: searchAtEcontrolCharging,
};
