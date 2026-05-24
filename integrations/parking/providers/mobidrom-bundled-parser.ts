import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";
import {
  fixMojibakeString,
  type MobidromMapOptions,
  type MobidromSiteBean,
} from "./mobidrom-common.js";

/**
 * Bundled parser for the NRW Mobidrom DATEX II "Parking Light" feeds.
 *
 * The DATEX Light JSON ships {static + live} per record, so a single fetch
 * powers both the durable poi_ingest table and the per-poi live Redis hash.
 * Five sources (parken-nrw, P+R aggregate, APAG, APCOA, GOLDBECK) share this
 * factory — `mapOpts` is the only per-source state captured at registration.
 */
export function makeMobidromBundledParser(
  mapOpts: Pick<MobidromMapOptions, "idPrefix" | "sourceId" | "operatorName" | "forceParkAndRide">,
): PoiBundledParseFn {
  return (buffer) => {
    const sites = parseFeed(buffer);
    const staticRows: PoiRow[] = [];
    const live = new Map<string, PoiLiveState>();

    for (const site of sites) {
      const poiId = site.externalId;
      if (!poiId) continue;
      const coords = normalizeCoordinates(
        site.locationAndDimension?.coordinatesForDisplay?.geometry?.coordinates,
      );
      if (!coords) continue;
      const [lng, lat] = coords;

      staticRows.push({
        poiId,
        lng,
        lat,
        payload: mobidromSiteToPayload(site, mapOpts, coords),
      });

      if (site.availableSpaces != null) {
        // Capacity is duplicated into the live entry so the API merger can
        // recompute "fullness" without re-reading the static row in cases
        // where the static side has drifted (e.g. operator briefly reported
        // higher capacity than the static catalog still knows about).
        live.set(poiId, {
          asOf: site.publicationTime ?? new Date().toISOString(),
          freeSpaces: site.availableSpaces,
          capacity: site.numberOfSpaces ?? null,
        });
      }
    }

    return { static: staticRows, live };
  };
}

function parseFeed(buffer: Buffer): MobidromSiteBean[] {
  const text = buffer.toString("utf-8");
  try {
    return JSON.parse(text, (_key, value) =>
      typeof value === "string" ? fixMojibakeString(value) : value,
    ) as MobidromSiteBean[];
  } catch {
    return [];
  }
}

// Some records in the aggregate feed use [lat, lng] order instead of GeoJSON
// standard [lng, lat]. Auto-detect by checking which value falls in the typical
// latitude range for NRW/DE (first coord > 20 implies it's a latitude).
function normalizeCoordinates(raw: [number, number] | undefined): [number, number] | null {
  if (!raw || raw.length !== 2) return null;
  const [a, b] = raw;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > 20 && b < 20) return [b, a];
  return [a, b];
}

/**
 * Serialise the static-side fields of a Mobidrom site bean to the jsonb
 * payload format consumed by `makeMobidromMapper`. `availableSpaces` (live)
 * is intentionally excluded — that field flows through the live Redis hash.
 */
export function mobidromSiteToPayload(
  site: MobidromSiteBean,
  opts: Pick<MobidromMapOptions, "operatorName" | "forceParkAndRide">,
  coordinates: [number, number],
): Record<string, unknown> {
  const name = site.name || site.description || "Parking";
  const openingHours = site.openingTimesDescription?.filter(Boolean).join("; ") || undefined;
  const tariffText = site.tariffDescription?.filter(Boolean).join("\n") || undefined;
  const maxHeightMeters = site.locationAndDimension?.dimension?.height ?? undefined;
  const maxHeight = maxHeightMeters != null ? Math.round(maxHeightMeters * 100) : undefined;

  return {
    coordinates,
    name,
    parkingType: derivedParkingType(site),
    capacity: site.numberOfSpaces ?? undefined,
    disabledSpaces: extractDisabledSpaces(site),
    chargingSpaces: extractChargingSpaces(site),
    maxHeight,
    fee: mapFee(site),
    feeDescription: tariffText,
    operator: opts.operatorName,
    address: site.locationAndDimension?.locationDescriptor ?? undefined,
    openingHours,
    state: site.isOpenNow === false ? "closed" : site.isOpenNow === true ? "open" : "unknown",
    parkAndRide: opts.forceParkAndRide || parseParkAndRide(site),
    url: site.urlLinkAddress ?? undefined,
  };
}

function derivedParkingType(
  site: MobidromSiteBean,
): "garage" | "surface" | "underground" | "unknown" {
  if (site.type === "CAR_PARK") return "garage";
  if (site.type === "OFF_STREET_PARKING_GROUND") return "surface";
  const desc = `${site.name ?? ""} ${site.description ?? ""}`.toLowerCase();
  if (desc.includes("tiefgarage")) return "underground";
  if (desc.includes("parkhaus")) return "garage";
  if (desc.includes("parkplatz")) return "surface";
  return "unknown";
}

function mapFee(site: MobidromSiteBean): "free" | "paid" | "unknown" | undefined {
  if (site.freeParking === true) return "free";
  if (site.freeParking === false) return "paid";
  if (site.tariffDescription && site.tariffDescription.length > 0) return "paid";
  return undefined;
}

function extractDisabledSpaces(site: MobidromSiteBean): number | undefined {
  for (const a of site.assignedFor ?? []) {
    const isDisabled = a.user === "DISABLED" || a.additionalAssignment === "DISABLED";
    if (isDisabled) return a.availableSpaces ?? 1;
  }
  if ((site.equipmentAndServices ?? []).some((e) => /behinderten/i.test(e))) {
    return 1;
  }
  return undefined;
}

function extractChargingSpaces(site: MobidromSiteBean): number | undefined {
  for (const a of site.assignedFor ?? []) {
    if (a.fuelType === "BATTERY" || a.fuelType === "ELECTRIC") {
      return a.availableSpaces ?? 1;
    }
  }
  if ((site.equipmentAndServices ?? []).some((e) => /aufladen|ladesäule|ladestation/i.test(e))) {
    return 1;
  }
  return undefined;
}

function parseParkAndRide(site: MobidromSiteBean): boolean | undefined {
  const haystack = [site.name ?? "", site.description ?? "", ...(site.zoneDescription ?? [])]
    .join(" ")
    .toLowerCase();
  if (/p\+r|park\s*&\s*ride|park\+ride|parkandride/.test(haystack)) return true;
  return undefined;
}
