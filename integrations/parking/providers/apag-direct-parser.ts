import type { ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Direct APAG (Aachener Parkhaus GmbH) feed via the operator's own API.
 *
 * Why a second APAG source: the existing `apag` source goes through
 * mobilitaetsdaten.nrw (Mobilithek), which has been intermittently broken
 * upstream. APAG also runs a public API on apag.de that powers their own
 * website's live occupancy display; reading it directly removes the
 * middleman and lets users see live data even when Mobilithek is down.
 *
 * One endpoint, no fan-out: `/api/v1/pms/facilities` already includes both
 * static metadata (uuid, name, lat/lng, address, capacity, opening hours,
 * rates) and current availability (available_parking, trend_parking), so a
 * single bundled fetch covers both the static table and the per-poi live
 * Redis hash. The companion `/occupancy` endpoint is a strict subset.
 *
 * The payload mirrors the Mobidrom mapper's expected shape so the runtime
 * reader can reuse `makeMobidromMapper` + `mergeMobidromLive` unchanged.
 *
 * Facility filter: the catalog also returns `BikeStation` entries (eight as
 * of writing). We only emit `ParkingFacility` rows; bike-station ingest
 * lives in a separate domain.
 */

interface ApagBilingual {
  de?: string | null;
  en?: string | null;
}

interface ApagRate {
  rate_type_name?: string;
  times?: string | null;
  prices?: string | null;
  notice?: string | null;
}

interface ApagFacility {
  uuid: string;
  type?: string;
  name?: string;
  label?: string;
  lat?: number;
  lng?: number;
  address_street?: string | null;
  address_zip?: string | null;
  address_city?: string | null;
  capacity_parking?: number | null;
  capacity_charging?: number | null;
  available_parking?: number | null;
  available_charging?: number | null;
  facility_type?: ApagBilingual | null;
  opening_times?: string | null;
  entrance_height?: string | null;
  short_term_parking_rates?: ApagRate[] | null;
  // Public APAG facility landing page; not provided by the API but trivially
  // synthesisable when needed — we leave `url` undefined here.
  updated_at?: string;
}

function pickEn(value: ApagBilingual | null | undefined): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value.en ?? value.de ?? undefined) || undefined;
}

function mapParkingType(facilityType: ApagBilingual | null | undefined): ParkingType {
  const de = facilityType?.de?.trim().toLowerCase();
  if (de === "parkhaus") return "garage";
  if (de === "parkplatz") return "surface";
  return "unknown";
}

function joinAddress(f: ApagFacility): string | undefined {
  const parts: string[] = [];
  if (f.address_street) parts.push(f.address_street);
  if (f.address_zip || f.address_city) {
    parts.push([f.address_zip, f.address_city].filter(Boolean).join(" "));
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function parseEntranceHeightCm(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  // Examples: "1.90 m", "2,00 m". Strip unit, normalise comma, then convert.
  const trimmed = value.replace(/m$/i, "").trim().replace(",", ".");
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 100);
}

function summariseRates(rates: ApagRate[] | null | undefined): string | undefined {
  if (!Array.isArray(rates) || rates.length === 0) return undefined;
  const first = rates.find((r) => r.prices)?.prices;
  return first ? first.trim() : undefined;
}

export function parseApagDirectBundled(): PoiBundledParseFn {
  return async (buffer, { log }) => {
    let data: unknown;
    try {
      data = JSON.parse(buffer.toString("utf-8"));
    } catch (err) {
      log.warn("apag-direct: failed to parse facilities JSON", {
        error: (err as Error).message,
      });
      return { static: [], live: new Map<string, PoiLiveState>() };
    }
    if (!Array.isArray(data)) {
      log.warn("apag-direct: facilities payload is not an array", {
        actual: typeof data,
      });
      return { static: [], live: new Map<string, PoiLiveState>() };
    }

    const staticRows: PoiRow[] = [];
    const live = new Map<string, PoiLiveState>();
    const now = new Date().toISOString();
    let skippedNonParking = 0;
    let skippedBadCoords = 0;

    for (const raw of data as ApagFacility[]) {
      if (!raw?.uuid) continue;
      if (raw.type !== "ParkingFacility") {
        skippedNonParking += 1;
        continue;
      }
      const lat = typeof raw.lat === "number" ? raw.lat : Number.NaN;
      const lng = typeof raw.lng === "number" ? raw.lng : Number.NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        skippedBadCoords += 1;
        continue;
      }

      const capacity =
        typeof raw.capacity_parking === "number" && raw.capacity_parking > 0
          ? raw.capacity_parking
          : undefined;
      const chargingSpaces =
        typeof raw.capacity_charging === "number" && raw.capacity_charging > 0
          ? raw.capacity_charging
          : undefined;
      const name = raw.label || raw.name || "Parking";
      const feeDescription = summariseRates(raw.short_term_parking_rates);

      staticRows.push({
        poiId: raw.uuid,
        lng,
        lat,
        payload: {
          coordinates: [lng, lat] as [number, number],
          name,
          parkingType: mapParkingType(raw.facility_type),
          capacity,
          chargingSpaces,
          maxHeight: parseEntranceHeightCm(raw.entrance_height),
          fee: "paid",
          feeDescription,
          operator: "APAG - Aachener Parkhaus GmbH",
          address: joinAddress(raw),
          openingHours: raw.opening_times ?? undefined,
          // Mirror what mobidrom-mapper consumes; rate summary already in feeDescription.
          state: "unknown",
          // English label for the facility kind, surfaced as auxiliary info in the
          // mapper (the mapper only inspects parkingType for the canonical enum).
          facilityKind: pickEn(raw.facility_type),
        },
      });

      const free =
        typeof raw.available_parking === "number" && raw.available_parking >= 0
          ? raw.available_parking
          : undefined;
      if (free !== undefined) {
        live.set(raw.uuid, {
          asOf: now,
          freeSpaces: free,
          capacity: capacity ?? null,
        });
      }
    }

    if (skippedNonParking > 0 || skippedBadCoords > 0) {
      log.info("apag-direct: parse summary", {
        emitted: staticRows.length,
        skippedNonParking,
        skippedBadCoords,
      });
    }

    return { static: staticRows, live };
  };
}
