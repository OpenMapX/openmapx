import type { PoiSourceLogger } from "@openmapx/poi-source-registry";

// Fintraffic / Digitraffic AFIR Charging Network API (Finland). Locations are
// a single GeoJSON FeatureCollection GET (the poi-ingest seed); tariffs are a
// separate, cursor-paginated feed the parser fetches for itself so structured
// per-EVSE pricing can be joined onto each station. No auth; CC BY 4.0.
//
// A live per-EVSE status feed also exists at
// `${BASE}/locations/statuses/all` (AVAILABLE/CHARGING/OUTOFORDER/...) but is
// intentionally NOT wired up yet — this source is static-only for now. Adding
// a live tier (mirroring de-ocpdb-live-parser.ts / ch-sfoe-live-parser.ts) is
// a natural follow-up once the static + tariffs join has proven out.
const BASE = "https://afir.digitraffic.fi/api/charging-network/v1";
export const FI_DIGITRAFFIC_LOCATIONS_URL = `${BASE}/locations/all`;
export const FI_DIGITRAFFIC_TARIFFS_URL = `${BASE}/tariffs`;

export interface FiPriceComponent {
  type?: string;
  price?: number;
  vat?: number;
  stepSize?: number;
}

export interface FiTariffRestrictions {
  startTime?: string | null;
  endTime?: string | null;
  minDuration?: number | null;
  maxDuration?: number | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface FiTariffElement {
  priceComponents?: FiPriceComponent[] | null;
  restrictions?: FiTariffRestrictions | null;
}

export interface FiTariff {
  id?: string;
  currency?: string;
  /** e.g. "AD_HOC_PAYMENT" (walk-up pricing) vs "REGULAR" (contracted/roaming). */
  type?: string;
  tariffAltUrl?: string;
  elements?: FiTariffElement[];
  lastUpdated?: string;
}

export interface FiConnector {
  standard?: string;
  powerType?: string;
  maxElectricPower?: number;
  tariffIds?: string[] | null;
}

export interface FiEvse {
  id?: string;
  connectors?: FiConnector[] | null;
}

export interface FiLocationAddress {
  street?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
}

export interface FiLocationOperator {
  details?: { name?: string; website?: string } | null;
}

export interface FiLocationProperties {
  id?: string;
  name?: string;
  operator?: FiLocationOperator | null;
  address?: FiLocationAddress | null;
  openingTimes?: { twentyFourSeven?: boolean } | null;
  modifiedAt?: string;
  evses?: FiEvse[] | null;
}

export interface FiLocation {
  geometry?: { coordinates?: [number, number] } | null;
  properties?: FiLocationProperties | null;
}

export interface FiLocationsFeatureCollection {
  features?: FiLocation[];
}

interface FiTariffsPage {
  pagination?: { nextCursor?: string | null } | null;
  tariffs?: FiTariff[];
}

const PAGE_TIMEOUT_MS = 30_000;
// ~2892 tariffs today; cap well above the observed page count so a runaway
// nextCursor can't loop forever.
const MAX_PAGES = 200;

function parsePage(text: string): FiTariffsPage {
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as FiTariffsPage) : {};
}

/**
 * Collects every tariff from the cursor-paginated Digitraffic tariffs feed
 * (`{pagination:{nextCursor}, tariffs:[...]}`) via `globalThis.fetch`, paging
 * with `?cursor=<nextCursor>` until `nextCursor` is null/absent. On any page
 * failure it logs and returns what it has so far (partial pricing beats a
 * crashed ingest).
 */
export async function fetchAllFiTariffs(log: PoiSourceLogger): Promise<FiTariff[]> {
  const tariffs: FiTariff[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (true) {
    if (pages >= MAX_PAGES) {
      log.warn(`fi-digitraffic-client: page cap (${MAX_PAGES}) hit — tariffs truncated`);
      break;
    }
    pages += 1;
    const url = cursor
      ? `${FI_DIGITRAFFIC_TARIFFS_URL}?cursor=${encodeURIComponent(cursor)}`
      : FI_DIGITRAFFIC_TARIFFS_URL;
    try {
      const res = await globalThis.fetch(url, {
        headers: { "Accept-Encoding": "gzip" },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.error(`fi-digitraffic-client: HTTP ${res.status} at ${url} — returning partial`);
        break;
      }
      const page = parsePage(await res.text());
      if (Array.isArray(page.tariffs)) tariffs.push(...page.tariffs);
      const next = page.pagination?.nextCursor;
      cursor = typeof next === "string" && next.length > 0 ? next : null;
      if (!cursor) break;
    } catch (err) {
      log.error(
        `fi-digitraffic-client: fetch failed at ${url} (${(err as Error).message}) — returning partial`,
      );
      break;
    }
  }
  return tariffs;
}
