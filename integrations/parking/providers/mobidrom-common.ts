/**
 * Shared types + mojibake repair for NRW Mobidrom DATEX II "Parking Light"
 * JSON feeds. The fetch/parse/map pipeline now lives in the POI ingest
 * registry — see mobidrom-bundled-parser.ts.
 */

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

export interface MobidromMapOptions {
  idPrefix: string;
  sourceId: string;
  operatorName?: string;
  /** When set, overrides the heuristic P+R detection — every record is flagged. */
  forceParkAndRide?: boolean;
}

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
