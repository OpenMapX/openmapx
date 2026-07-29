import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import {
  cleanString,
  connector,
  parseInteger,
  parseLocalizedNumber,
  stableHashId,
} from "./utils.js";

/**
 * data.go.kr keyless "표준데이터" (standard data) download endpoint for the
 * nationwide EV charging station dataset (전국전기차충전소표준데이터, dataset
 * 15013115, provided by 한국환경공단 / Korea Environment Corporation). This is
 * the same AJAX call the "다운로드" buttons on the dataset page make
 * (`/download/columList.json` then `/download/standard.json`) — no API key,
 * cookie, or session is required; verified with a plain `curl`. `perPage` is
 * set far above the current ~6k row count so the whole dataset comes back in
 * one page; `totalCount` must be present but is not actually used server-side
 * to cap the result (verified: passing a deliberately wrong value still
 * returns every row).
 */
const KR_DATAGO_COLUMNS = [
  "CHRSTN_NM",
  "CHRSTN_LC_DESC",
  "INSTL_CTPRVN_NM",
  "RESTDE",
  "USE_OPEN_TIME",
  "USE_CLOSE_TIME",
  "SLOW_CHRSTN_YN",
  "FAST_CHRSTN_YN",
  "FAST_CHRSTN_TYPE",
  "SLOW_CHRSTN_CO",
  "FAST_CHRSTN_CO",
  "PRKPLCE_LEVY_YN",
  "RDNMADR",
  "LNMADR",
  "INSTITUTION_NM",
  "PHONE_NUMBER",
  "LATITUDE",
  "LONGITUDE",
  "REFERENCE_DATE",
];

function buildKrDatagoUrl(): string {
  const params = new URLSearchParams();
  for (const column of KR_DATAGO_COLUMNS) params.append("colNmList", column);
  params.set("svcTableNm", "tn_pubr_public_elcty_car_chrstn_svc");
  params.set("totalCount", "999999");
  params.set("perPage", "50000");
  params.set("page", "1");
  return `https://www.data.go.kr/download/standard.json?${params.toString()}`;
}

export const KR_DATAGO_URL = buildKrDatagoUrl();
const SOURCE_URL = "https://www.data.go.kr/data/15013115/standard.do";

interface KrDatagoRow {
  CHRSTN_NM?: string;
  CHRSTN_LC_DESC?: string;
  INSTL_CTPRVN_NM?: string;
  RESTDE?: string;
  USE_OPEN_TIME?: string;
  USE_CLOSE_TIME?: string;
  SLOW_CHRSTN_YN?: string;
  FAST_CHRSTN_YN?: string;
  FAST_CHRSTN_TYPE?: string;
  SLOW_CHRSTN_CO?: string | number;
  FAST_CHRSTN_CO?: string | number;
  PRKPLCE_LEVY_YN?: string;
  RDNMADR?: string;
  LNMADR?: string;
  INSTITUTION_NM?: string;
  PHONE_NUMBER?: string;
  LATITUDE?: string | number;
  LONGITUDE?: string | number;
  REFERENCE_DATE?: string;
}

// "휴점일" (closed days) is almost always one of a handful of "no closed
// day" synonyms; only surface it as a note when it names an actual closure.
const NO_CLOSURE = new Set(["연중무휴", "없음", "-", "무휴", "24시간 이용가능", "n", "N"]);

function closedDaysNote(value: string | undefined): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned || NO_CLOSURE.has(cleaned)) return undefined;
  return `Closed: ${cleaned}`;
}

// USE_OPEN_TIME/USE_CLOSE_TIME are HH:MM strings. "00:00"–"00:00"/"23:59"/
// "24:00" are all the site's ways of saying round-the-clock.
function openingHours(open: string | undefined, close: string | undefined): string | undefined {
  const o = cleanString(open);
  const c = cleanString(close);
  if (!o || !c) return undefined;
  if (o === "00:00" && (c === "00:00" || c === "23:59" || c === "24:00")) return "24/7";
  return `${o} - ${c}`;
}

/**
 * FAST_CHRSTN_TYPE is free text describing which DC (and, confusingly, 3-phase
 * AC) connectors a fast charger unit exposes — e.g. "DC차데모+AC3상+DC콤보" or
 * "DC콤보". Korean multi-standard fast chargers typically bundle CHAdeMO/CCS/
 * AC3상 sockets on one physical unit sharing the same power budget, so each
 * detected type gets the same quantity (FAST_CHRSTN_CO) rather than the count
 * being split across types.
 */
function fastConnectorTypes(value: string | undefined): string[] {
  const cleaned = cleanString(value) ?? "";
  const types: string[] = [];
  if (cleaned.includes("차데모")) types.push("CHAdeMO");
  if (cleaned.includes("콤보")) types.push("CCS (Type 2)");
  if (cleaned.includes("3상")) types.push("Type 2");
  return types.length > 0 ? types : ["Unknown"];
}

function rowConnectors(row: KrDatagoRow): EvChargingConnector[] {
  const connectors: EvChargingConnector[] = [];

  const slowCount = parseInteger(row.SLOW_CHRSTN_CO) ?? 0;
  if (slowCount > 0) {
    // AC완속 (slow AC charging) is always a Type 2 connector in this feed.
    connectors.push(connector({ type: "Type 2", quantity: slowCount }));
  }

  const fastCount = parseInteger(row.FAST_CHRSTN_CO) ?? 0;
  if (fastCount > 0) {
    for (const type of fastConnectorTypes(row.FAST_CHRSTN_TYPE)) {
      connectors.push(connector({ type, quantity: fastCount }));
    }
  }

  return connectors;
}

function rowToPoi(row: KrDatagoRow): PoiRow | null {
  const lat = parseLocalizedNumber(row.LATITUDE);
  const lng = parseLocalizedNumber(row.LONGITUDE);
  if (lat === undefined || lng === undefined) return null;

  const name = cleanString(row.CHRSTN_NM);
  const address = cleanString(row.RDNMADR) ?? cleanString(row.LNMADR);
  const institution = cleanString(row.INSTITUTION_NM);
  const poiId = stableHashId(name, address, lat, lng, institution);

  const notes: string[] = [];
  const closed = closedDaysNote(row.RESTDE);
  if (closed) notes.push(closed);
  const phone = cleanString(row.PHONE_NUMBER);
  if (phone) notes.push(`Tel: ${phone}`);

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name: name ?? "EV Charging Station",
      address: {
        line1: address,
        state: cleanString(row.INSTL_CTPRVN_NM),
        country: "South Korea",
      },
      operator: institution ? { name: institution } : undefined,
      status: "unknown",
      connectors: rowConnectors(row),
      usageType:
        cleanString(row.PRKPLCE_LEVY_YN)?.toUpperCase() === "Y" ? "Paid parking" : undefined,
      openingHours: openingHours(row.USE_OPEN_TIME, row.USE_CLOSE_TIME),
      updatedAt: cleanString(row.REFERENCE_DATE),
      sourceUrl: SOURCE_URL,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

export const parseKrDatago: PoiStaticParseFn = (buffer) => {
  const rows = JSON.parse(buffer.toString("utf8")) as KrDatagoRow[];
  const out: PoiRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const poi = rowToPoi(row);
    if (!poi || seen.has(poi.poiId)) continue;
    seen.add(poi.poiId);
    out.push(poi);
  }
  return out;
};
