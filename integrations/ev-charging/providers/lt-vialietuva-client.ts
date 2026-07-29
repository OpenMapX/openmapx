import type { PoiSourceLogger } from "@openmapx/poi-source-registry";
import type { OcpiRestrictionsLike } from "./ocpi-tariff.js";

// Via Lietuva (Lithuania) national EV charging open data — OCPI 2.3.0 JSON,
// served from behind Cloudflare at ev.vialietuva.lt. Requests without a
// User-Agent are blocked by Cloudflare, so every request below sends one.
// Both modules are paginated with the standard OCPI `?offset=&limit=`
// contract, with the grand total in the `x-total-count` response header
// (~2984 locations, ~1470 tariffs today). The OCPI spec has the response body
// as a bare JSON array, but some deployments (e.g. OCPDB) wrap it in
// `{ items: [...] }` / `{ data: [...] }` instead — parseBody accepts a bare
// array or either wrapper shape defensively so a format quirk here doesn't
// silently drop every row.
const BASE = "https://ev.vialietuva.lt/ocpi/2.3.0";
export const LT_VIALIETUVA_LOCATIONS_URL = `${BASE}/locations`;
export const LT_VIALIETUVA_TARIFFS_URL = `${BASE}/tariffs`;

const USER_AGENT = "OpenMapX/1.0";
const PAGE_LIMIT = 200;
const PAGE_TIMEOUT_MS = 30_000;
// ~2984 locations / ~1470 tariffs at PAGE_LIMIT=200 need ~15/~8 pages; cap
// well above both so a stuck or wrong `x-total-count` can't loop forever.
const MAX_PAGES = 200;

export interface LtCoordinates {
  latitude?: string;
  longitude?: string;
}

export interface LtOperator {
  name?: string;
  website?: string;
}

export interface LtConnector {
  id?: string | number;
  standard?: string;
  power_type?: string;
  max_electric_power?: number;
  tariff_ids?: Array<string | number | null> | null;
}

export interface LtEvse {
  uid?: string | number;
  status?: string;
  connectors?: LtConnector[];
}

export interface LtLocation {
  id?: string | number;
  country_code?: string;
  party_id?: string;
  name?: string;
  address?: string;
  city?: string;
  country?: string;
  coordinates?: LtCoordinates;
  operator?: LtOperator | null;
  evses?: LtEvse[];
  last_updated?: string;
}

export interface LtDisplayText {
  language?: string;
  text?: string;
}

export interface LtPriceComponent {
  type?: string;
  // Via Lietuva serializes price/vat as STRINGS ("0.3000", "21.0000"), unlike
  // nl-dotnl/de-ocpdb which use numbers — see lt-vialietuva-tariff.ts.
  price?: string | number | null;
  step_size?: number | null;
  vat?: string | number | null;
}

export interface LtTariffElement {
  price_components?: LtPriceComponent[] | null;
  restrictions?: OcpiRestrictionsLike | null;
}

export interface LtTariff {
  id?: string | number;
  country_code?: string;
  party_id?: string;
  currency?: string;
  tariff_alt_text?: LtDisplayText[] | null;
  tariff_alt_url?: string | null;
  elements?: LtTariffElement[];
  last_updated?: string;
}

function parseBody<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    const obj = body as { data?: unknown; items?: unknown };
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}

async function fetchPage<T>(
  url: string,
  offset: number,
  log: PoiSourceLogger,
): Promise<{ items: T[]; totalCount: number | null } | null> {
  try {
    const res = await globalThis.fetch(`${url}?offset=${offset}&limit=${PAGE_LIMIT}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.error(
        `lt-vialietuva-client: HTTP ${res.status} at offset ${offset} for ${url} — returning partial`,
      );
      return null;
    }
    const totalHeader = res.headers.get("x-total-count");
    const totalCount = totalHeader !== null ? Number.parseInt(totalHeader, 10) : Number.NaN;
    const body = (await res.json()) as unknown;
    return {
      items: parseBody<T>(body),
      totalCount: Number.isFinite(totalCount) ? totalCount : null,
    };
  } catch (err) {
    log.error(
      `lt-vialietuva-client: fetch failed at offset ${offset} for ${url} (${(err as Error).message}) — returning partial`,
    );
    return null;
  }
}

/**
 * Collects every item from a paginated Via Lietuva OCPI module (locations or
 * tariffs), following `offset`/`limit` until a page returns zero items or the
 * cumulative offset reaches `x-total-count`. On any page failure it logs and
 * returns what it has so far (partial data beats a crashed ingest).
 *
 * `/tariffs` does NOT honor `offset`/`limit` at all (confirmed against the
 * live API — every request, regardless of params, returns the complete
 * ~1470-row set with no `x-total-count` header), unlike `/locations` which
 * does paginate and always carries the header. So: no `x-total-count` on the
 * FIRST page is treated as "this module returned everything already" and
 * stops immediately, rather than re-requesting (and re-appending) the same
 * full payload up to MAX_PAGES times.
 */
async function fetchAllPages<T>(url: string, log: PoiSourceLogger): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let total: number | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await fetchPage<T>(url, offset, log);
    if (!page) break;
    items.push(...page.items);
    if (page.totalCount !== null) {
      total = page.totalCount;
    } else if (pages === 0) {
      break;
    }
    // Advance by a FIXED page size, NOT the returned item count. The Via
    // Lietuva /locations server is flaky: for `limit=200` it returns a
    // variable, smaller window (~140–190 items) whose ids are NOT contiguous
    // with the previous page (page 0 can end at id 1650 while page 1 starts at
    // 1525). Stepping by items.length therefore leaves GAPS as well as
    // overlaps and drops ~2.5% of stations; a fixed offset step lets the loop
    // sweep the whole range and the caller's composite-key dedupe absorbs the
    // (now larger) overlap. The header over-reports — `x-total-count` ~2986
    // while the API only ever serves ~1838 distinct locations no matter how
    // you page — so it is a safe upper bound to drive the loop to, never an
    // under-count that would stop early. Don't break on an empty page: a mid-
    // range gap must not end the sweep before offset reaches `total`.
    offset += PAGE_LIMIT;
    if (total !== null && offset >= total) break;
    if (pages === MAX_PAGES - 1) {
      log.warn(`lt-vialietuva-client: page cap (${MAX_PAGES}) hit for ${url} — data truncated`);
    }
  }
  return items;
}

export async function fetchAllLtLocations(log: PoiSourceLogger): Promise<LtLocation[]> {
  return fetchAllPages<LtLocation>(LT_VIALIETUVA_LOCATIONS_URL, log);
}

export async function fetchAllLtTariffs(log: PoiSourceLogger): Promise<LtTariff[]> {
  return fetchAllPages<LtTariff>(LT_VIALIETUVA_TARIFFS_URL, log);
}
