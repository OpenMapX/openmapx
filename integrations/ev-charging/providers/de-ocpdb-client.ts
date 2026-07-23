import type { PoiSourceLogger } from "@openmapx/poi-source-registry";

// MobiData BW's OCPDB deployment aggregates German charging data nationwide
// (all 16 states, via Mobilithek/DATEX II) and exposes it as OCPI with NO auth
// under Datenlizenz Deutschland – Namensnennung 2.0. Feeds are paginated
// (?limit=&offset=; response carries items + next_offset), max limit 1000. The
// `?source=` param is IGNORED, but `?source_uid=<uid>` filters to one source
// (used by the live tier); the static tier pages the whole feed.
const BASE = "https://api.mobidata-bw.de/ocpdb/api/ocpi/2.2";
export const DE_OCPDB_LOCATIONS_URL = `${BASE}/locations?limit=1000`;
export const DE_OCPDB_TARIFFS_URL = `${BASE}/tariffs?limit=1000`;
// The tariff↔EVSE link OCPDB omits from OCPI 2.2 (empty connector.tariff_ids)
// is exposed at the OCPI 3.0 tariff-associations endpoint; /sources lists every
// source with a realtime flag so the live tier can page only realtime ones.
export const DE_OCPDB_ASSOCIATIONS_URL =
  "https://api.mobidata-bw.de/ocpdb/api/public/ocpi/3.0/tariff-associations?limit=1000";
export const DE_OCPDB_SOURCES_URL =
  "https://api.mobidata-bw.de/ocpdb/api/public/v1/sources?limit=100";

export function sourceUidUrl(baseUrl: string, sourceUid: string): string {
  return `${baseUrl}&source_uid=${encodeURIComponent(sourceUid)}`;
}

interface OcpdbSource {
  uid?: string;
  realtime_data_updated_at?: string | null;
}

/** Parses a `/sources` response, returning the `uid`s that carry realtime data. */
export function realtimeSourceUids(sourcesBuffer: Buffer): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourcesBuffer.toString("utf-8"));
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const uids: string[] = [];
  for (const raw of items) {
    const s = raw as OcpdbSource;
    if (
      typeof s.uid === "string" &&
      typeof s.realtime_data_updated_at === "string" &&
      s.realtime_data_updated_at.length > 0
    ) {
      uids.push(s.uid);
    }
  }
  return uids;
}

const PAGE_TIMEOUT_MS = 30_000;
// ~91k locations and ~125k tariffs at limit=1000 need ~91 and ~126 pages; cap
// well above both so a runaway `next_offset` can't loop forever.
const MAX_PAGES = 400;

interface OcpdbPage {
  items?: unknown[];
  next_offset?: number | null;
}

function parsePage(buffer: Buffer): OcpdbPage {
  const parsed = JSON.parse(buffer.toString("utf-8")) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as OcpdbPage) : {};
}

/**
 * Collects every item from a paginated OCPDB OCPI feed. The data-manager fetch
 * stage delivers page 1 as `seed`; this follows `next_offset` for the rest via
 * `globalThis.fetch`. On any page failure it logs and returns what it has so
 * far (partial data beats a crashed ingest). Pass no `seed` to page a
 * secondary feed (e.g. tariffs) the fetch stage didn't pre-fetch.
 */
export async function fetchAllOcpdbItems(
  baseUrl: string,
  log: PoiSourceLogger,
  seed?: Buffer,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let offset: number | null;

  if (seed) {
    const first = parsePage(seed);
    if (Array.isArray(first.items)) items.push(...first.items);
    offset = typeof first.next_offset === "number" ? first.next_offset : null;
  } else {
    offset = 0;
  }

  let pages = 0;
  while (offset !== null) {
    if (pages >= MAX_PAGES) {
      log.warn(`de-ocpdb-client: page cap (${MAX_PAGES}) hit for ${baseUrl} — data truncated`);
      break;
    }
    pages += 1;
    try {
      const res = await globalThis.fetch(`${baseUrl}&offset=${offset}`, {
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.error(
          `de-ocpdb-client: HTTP ${res.status} at offset ${offset} for ${baseUrl} — returning partial`,
        );
        break;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const page = parsePage(buffer);
      if (Array.isArray(page.items)) items.push(...page.items);
      offset = typeof page.next_offset === "number" ? page.next_offset : null;
    } catch (err) {
      log.error(
        `de-ocpdb-client: fetch failed at offset ${offset} for ${baseUrl} (${(err as Error).message}) — returning partial`,
      );
      break;
    }
  }
  return items;
}
