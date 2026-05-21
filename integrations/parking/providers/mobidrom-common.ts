/**
 * Shared parser for NRW Mobidrom DATEX II "Parking Light" JSON feeds.
 *
 * All feeds exposed via `systemadapter-mobilithek-exporter/*.json` return an
 * array of `mobidp.parking.ParkingSite$Bean` objects with identical shape,
 * so a single parser handles the aggregate `parken-nrw.json` and the
 * operator-specific feeds (APCOA, APAG, GOLDBECK).
 */

import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

export interface MobidromAssignment {
  typeOfAssignment?: string | null;
  vehicleType?: string | null;
  fuelType?: string | null;
  user?: string | null;
  additionalAssignment?: string | null;
  availableSpaces?: number | null;
}

export interface MobidromDimension {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  usableArea?: number | null;
}

export interface MobidromLocation {
  locationDescriptor?: string | null;
  specificAccessInformation?: string[];
  level?: string | null;
  roadNumber?: string | null;
  roadName?: string | null;
  dimension?: MobidromDimension | null;
  coordinatesForDisplay?: {
    geometry?: { type?: string; coordinates?: [number, number] };
    srid?: number;
  } | null;
}

export interface MobidromSiteBean {
  "@type"?: string;
  description?: string | null;
  name?: string | null;
  publicationTime?: string;
  externalId: string;
  externalVersion?: string | null;
  type?: "CAR_PARK" | "OFF_STREET_PARKING_GROUND" | string | null;
  equipmentAndServices?: string[];
  security?: string[];
  openingTimesDescription?: string[];
  isOpenNow?: boolean;
  temporaryClosed?: unknown;
  operatorInformation?: unknown[];
  tariffDescription?: string[];
  freeParking?: boolean | null;
  zoneDescription?: string[];
  urlLinkAddress?: string | null;
  maximumParkingDuration?: unknown;
  numberOfSpaces?: number | null;
  availableSpaces?: number | null;
  id?: string | null;
  occupancyTrend?: "STABLE" | "INCREASING" | "DECREASING" | null;
  assignedFor?: MobidromAssignment[];
  locationAndDimension?: MobidromLocation | null;
}

const cacheByUrl = new Map<string, { sites: MobidromSiteBean[]; fetchedAt: number }>();

/**
 * Detect and repair UTF-8-decoded-as-Windows-1252 mojibake (e.g. "SÃ¼d" → "Süd").
 * Some Mobidrom feeds (notably the Park+Ride aggregate) double-encode their
 * text fields upstream; the fix is to reinterpret each code point as a byte
 * and decode the resulting sequence as UTF-8.
 *
 * Bytes 0x80–0x9F of Windows-1252 map to code points outside the 0x00–0xFF
 * range (e.g. byte 0x9F is U+0178 "Ÿ"), so a direct `charCode → byte` cast
 * would fail on those. The table below reverses that mapping.
 *
 * Returns the input unchanged when no mojibake is detected, when a character
 * can't be mapped back to a byte, or when the reinterpretation produces
 * invalid UTF-8.
 */
const MOJIBAKE_PATTERN = /[ÃÂ]/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Windows-1252 code points in 0x80–0x9F that aren't in the Latin-1 range. */
const CP1252_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

export function fixMojibakeString(s: string): string {
  if (!MOJIBAKE_PATTERN.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0xff) {
      bytes[i] = c;
    } else {
      const mapped = CP1252_TO_BYTE.get(c);
      if (mapped === undefined) return s;
      bytes[i] = mapped;
    }
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return s;
  }
}

/**
 * Fetch a Mobidrom feed URL with in-memory caching.
 * The aggregate `parken-nrw.json` updates every minute; operator feeds daily.
 * A 5-minute TTL keeps load low while catching frequent real-time updates.
 */
export async function fetchMobidromSites(url: string, ttlMs: number): Promise<MobidromSiteBean[]> {
  const cached = cacheByUrl.get(url);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.sites;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    if (cached) return cached.sites;
    throw new Error(`Mobidrom feed ${url} failed: ${res.status}`);
  }

  const text = await res.text();
  const sites = JSON.parse(text, (_key, value) =>
    typeof value === "string" ? fixMojibakeString(value) : value,
  ) as MobidromSiteBean[];
  cacheByUrl.set(url, { sites, fetchedAt: Date.now() });
  return sites;
}

/**
 * Some records in the aggregate feed use [lat, lng] order instead of GeoJSON
 * standard [lng, lat]. Auto-detect by checking which value falls in the typical
 * latitude range for NRW/DE (first coord > 20 implies it's a latitude).
 */
function normalizeCoordinates(raw: [number, number] | undefined): [number, number] | null {
  if (!raw || raw.length !== 2) return null;
  const [a, b] = raw;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > 20 && b < 20) return [b, a]; // [lat, lng] → [lng, lat]
  return [a, b];
}

function mapParkingType(site: MobidromSiteBean): ParkingType {
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

export interface MobidromMapOptions {
  idPrefix: string;
  sourceId: string;
  operatorName?: string;
  /** When set, overrides the heuristic P+R detection — every record is flagged. */
  forceParkAndRide?: boolean;
}

export function mapMobidromSite(
  site: MobidromSiteBean,
  opts: MobidromMapOptions,
): ParkingFacility | null {
  const coords = normalizeCoordinates(
    site.locationAndDimension?.coordinatesForDisplay?.geometry?.coordinates,
  );
  if (!coords) return null;

  const name = site.name || site.description || "Parking";
  const openingHours = site.openingTimesDescription?.filter(Boolean).join("; ") || undefined;
  const tariffText = site.tariffDescription?.filter(Boolean).join("\n") || undefined;
  const maxHeightMeters = site.locationAndDimension?.dimension?.height ?? undefined;

  return {
    id: `${opts.idPrefix}:${site.externalId}`,
    name,
    coordinates: coords,
    sources: [opts.sourceId],
    parkingType: mapParkingType(site),
    capacity: site.numberOfSpaces ?? undefined,
    freeSpaces: site.availableSpaces ?? undefined,
    hasRealtimeData: site.availableSpaces != null,
    disabledSpaces: extractDisabledSpaces(site),
    chargingSpaces: extractChargingSpaces(site),
    maxHeight: maxHeightMeters != null ? Math.round(maxHeightMeters * 100) : undefined,
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

export function filterByBbox(facilities: ParkingFacility[], bbox: BoundingBox): ParkingFacility[] {
  return facilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export function bboxOverlaps(bbox: BoundingBox, coverage: BoundingBox): boolean {
  return (
    bbox.south <= coverage.north &&
    bbox.north >= coverage.south &&
    bbox.west <= coverage.east &&
    bbox.east >= coverage.west
  );
}
