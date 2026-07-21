import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";

/**
 * Singapore HDB carpark static parser.
 *
 * One fetch returns a single page of the datastore_search endpoint
 * (`https://data.gov.sg/api/action/datastore_search?resource_id=...`).
 *
 * The pre-migration provider paginated through ~2,300 records via a
 * `limit=500&offset=N` loop. To keep the pipeline a single-fetch contract,
 * we configure the ingest URL with `limit=5000` (well above the total) so the
 * one fetch returns the entire catalog. This avoids encoding the loop here
 * while staying within the gov.sg 60 req/min rate budget.
 *
 * Coordinates arrive as SVY21 (Northing/Easting); this parser converts them
 * to WGS84 inline using the same closed-form inverse projection the
 * pre-migration code used.
 *
 * Pre-migration id was `sg:${record.car_park_no}`.
 */

interface StaticCarparkRecord {
  car_park_no: string;
  address: string;
  x_coord: string;
  y_coord: string;
  car_park_type: string;
  type_of_parking_system: string;
  short_term_parking: string;
  free_parking: string;
  night_parking: string;
  car_park_decks: number;
  gantry_height: number;
  car_park_basement: string;
}

interface StaticDatastoreResponse {
  result?: {
    records?: StaticCarparkRecord[];
  };
}

// SVY21 ↔ WGS84 projection constants (from cgcai/SVY21, MIT-compatible).
const SVY21_A = 6378137;
const SVY21_F = 1 / 298.257223563;
const SVY21_OLAT = 1.366666;
const SVY21_OLON = 103.833333;
const SVY21_ON = 38744.572;
const SVY21_OE = 28001.642;
const SVY21_K = 1;

const SVY21_B = SVY21_A * (1 - SVY21_F);
const SVY21_E2 = 2 * SVY21_F - SVY21_F * SVY21_F;
const SVY21_E4 = SVY21_E2 * SVY21_E2;
const SVY21_E6 = SVY21_E4 * SVY21_E2;
const SVY21_A0 = 1 - SVY21_E2 / 4 - (3 * SVY21_E4) / 64 - (5 * SVY21_E6) / 256;
const SVY21_A2 = (3 / 8) * (SVY21_E2 + SVY21_E4 / 4 + (15 * SVY21_E6) / 128);
const SVY21_A4 = (15 / 256) * (SVY21_E4 + (3 * SVY21_E6) / 4);
const SVY21_A6 = (35 * SVY21_E6) / 3072;
const SVY21_N = (SVY21_A - SVY21_B) / (SVY21_A + SVY21_B);
const SVY21_N2 = SVY21_N * SVY21_N;
const SVY21_N3 = SVY21_N2 * SVY21_N;
const SVY21_N4 = SVY21_N2 * SVY21_N2;
const SVY21_G =
  SVY21_A *
  (1 - SVY21_N) *
  (1 - SVY21_N2) *
  (1 + (9 * SVY21_N2) / 4 + (225 * SVY21_N4) / 64) *
  (Math.PI / 180);

function calcM(latDeg: number): number {
  const latR = (latDeg * Math.PI) / 180;
  return (
    SVY21_A *
    (SVY21_A0 * latR -
      SVY21_A2 * Math.sin(2 * latR) +
      SVY21_A4 * Math.sin(4 * latR) -
      SVY21_A6 * Math.sin(6 * latR))
  );
}

function calcRho(sin2Lat: number): number {
  return (SVY21_A * (1 - SVY21_E2)) / (1 - SVY21_E2 * sin2Lat) ** 1.5;
}

function calcV(sin2Lat: number): number {
  return SVY21_A / Math.sqrt(1 - SVY21_E2 * sin2Lat);
}

export function svy21ToWgs84(northing: number, easting: number): { lat: number; lng: number } {
  const Nprime = northing - SVY21_ON;
  const Mo = calcM(SVY21_OLAT);
  const Mprime = Mo + Nprime / SVY21_K;
  const sigma = (Mprime * Math.PI) / (180 * SVY21_G);

  const latPrime =
    sigma +
    ((3 * SVY21_N) / 2 - (27 * SVY21_N3) / 32) * Math.sin(2 * sigma) +
    ((21 * SVY21_N2) / 16 - (55 * SVY21_N4) / 32) * Math.sin(4 * sigma) +
    ((151 * SVY21_N3) / 96) * Math.sin(6 * sigma) +
    ((1097 * SVY21_N4) / 512) * Math.sin(8 * sigma);

  const sinLatPrime = Math.sin(latPrime);
  const sin2LatPrime = sinLatPrime * sinLatPrime;

  const rhoPrime = calcRho(sin2LatPrime);
  const vPrime = calcV(sin2LatPrime);
  const psiPrime = vPrime / rhoPrime;
  const psiPrime2 = psiPrime * psiPrime;
  const psiPrime3 = psiPrime2 * psiPrime;
  const psiPrime4 = psiPrime3 * psiPrime;
  const tPrime = Math.tan(latPrime);
  const tPrime2 = tPrime * tPrime;
  const tPrime4 = tPrime2 * tPrime2;
  const tPrime6 = tPrime4 * tPrime2;
  const Eprime = easting - SVY21_OE;
  const x = Eprime / (SVY21_K * vPrime);
  const x2 = x * x;
  const x3 = x2 * x;
  const x5 = x3 * x2;
  const x7 = x5 * x2;

  const latFactor = tPrime / (SVY21_K * rhoPrime);
  const latTerm1 = latFactor * ((Eprime * x) / 2);
  const latTerm2 =
    latFactor *
    ((Eprime * x3) / 24) *
    (-4 * psiPrime2 + 9 * psiPrime * (1 - tPrime2) + 12 * tPrime2);
  const latTerm3 =
    latFactor *
    ((Eprime * x5) / 720) *
    (8 * psiPrime4 * (11 - 24 * tPrime2) -
      12 * psiPrime3 * (21 - 71 * tPrime2) +
      15 * psiPrime2 * (15 - 98 * tPrime2 + 15 * tPrime4) +
      180 * psiPrime * (5 * tPrime2 - 3 * tPrime4) +
      360 * tPrime4);
  const latTerm4 =
    latFactor * ((Eprime * x7) / 40320) * (1385 - 3633 * tPrime2 + 4095 * tPrime4 + 1575 * tPrime6);

  const lat = latPrime - latTerm1 + latTerm2 - latTerm3 + latTerm4;

  const secLatPrime = 1 / Math.cos(lat);
  const lonTerm1 = x * secLatPrime;
  const lonTerm2 = ((x3 * secLatPrime) / 6) * (psiPrime + 2 * tPrime2);
  const lonTerm3 =
    ((x5 * secLatPrime) / 120) *
    (-4 * psiPrime3 * (1 - 6 * tPrime2) +
      psiPrime2 * (9 - 68 * tPrime2) +
      72 * psiPrime * tPrime2 +
      24 * tPrime4);
  const lonTerm4 =
    ((x7 * secLatPrime) / 5040) * (61 + 662 * tPrime2 + 1320 * tPrime4 + 720 * tPrime6);
  const lon = (SVY21_OLON * Math.PI) / 180 + lonTerm1 - lonTerm2 + lonTerm3 - lonTerm4;

  return { lat: lat / (Math.PI / 180), lng: lon / (Math.PI / 180) };
}

const TYPE_MAP: Record<string, "garage" | "underground" | "surface"> = {
  "MULTI-STOREY CAR PARK": "garage",
  "BASEMENT CAR PARK": "underground",
  "SURFACE CAR PARK": "surface",
  "COVERED CAR PARK": "garage",
  "MECHANISED CAR PARK": "garage",
};

function formatAddress(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bBlk\b/g, "Blk")
    .replace(/\bHdb\b/g, "HDB")
    .replace(/\bMrt\b/g, "MRT")
    .replace(/\bAve\b/g, "Ave")
    .replace(/\bSt\b/g, "St")
    .replace(/\bDr\b/g, "Dr")
    .replace(/\bRd\b/g, "Rd")
    .replace(/\bCres\b/g, "Cres")
    .replace(/\bCl\b/g, "Cl");
}

export const parseSgHdbStatic: PoiStaticParseFn = (buffer) => {
  const text = buffer.toString("utf-8");
  let data: StaticDatastoreResponse;
  try {
    data = JSON.parse(text) as StaticDatastoreResponse;
  } catch {
    return [];
  }
  const records = data?.result?.records;
  if (!Array.isArray(records)) return [];

  const out: PoiRow[] = [];
  for (const record of records) {
    if (!record?.car_park_no) continue;
    const x = Number.parseFloat(record.x_coord);
    const y = Number.parseFloat(record.y_coord);
    if (Number.isNaN(x) || Number.isNaN(y) || x === 0 || y === 0) continue;

    const { lat, lng } = svy21ToWgs84(y, x);
    if (lat < 1.1 || lat > 1.5 || lng < 103.5 || lng > 104.1) continue;

    const gantryHeightM = record.gantry_height;
    const maxHeight =
      gantryHeightM != null && gantryHeightM > 0 ? Math.round(gantryHeightM * 100) : undefined;

    const parkingType = TYPE_MAP[record.car_park_type] ?? "unknown";
    const freeParking = record.free_parking !== "NO";

    out.push({
      poiId: record.car_park_no,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: formatAddress(record.address),
        address: record.address,
        parkingType,
        fee: freeParking ? "free" : "paid",
        maxHeight,
      },
    });
  }
  return out;
};
