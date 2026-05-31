// integrations/hotels/wikidata.ts
/** OTA hotel ids resolved from a Wikidata entity (any subset may be present). */
export interface WikidataOtaIds {
  expedia?: string; // P5651, e.g. "h7172034"
  booking?: string; // P3607, e.g. "eg/windsor-palace"
  hotelscom?: string; // P3898
  agoda?: string; // P6008 (slug) — prefer slug for the hotel URL
  agodaNumeric?: string; // P10533
  tripcom?: string; // P10425 (numeric)
}

const PROP: Record<keyof WikidataOtaIds, string> = {
  expedia: "P5651",
  booking: "P3607",
  hotelscom: "P3898",
  agoda: "P6008",
  agodaNumeric: "P10533",
  tripcom: "P10425",
};

interface WdEntities {
  entities?: Record<
    string,
    { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> }
  >;
}

/** First string value of a Wikidata external-id claim, or undefined. */
function claimValue(
  claims: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> | undefined,
  prop: string,
): string | undefined {
  const v = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
  return typeof v === "string" ? v : undefined;
}

/** Pure: extract OTA ids from a Special:EntityData JSON for `qid`. */
export function parseWikidataOtaIds(json: WdEntities, qid: string): WikidataOtaIds {
  const claims = json.entities?.[qid]?.claims;
  const out: WikidataOtaIds = {};
  for (const [key, prop] of Object.entries(PROP) as [keyof WikidataOtaIds, string][]) {
    const v = claimValue(claims, prop);
    if (v) out[key] = v;
  }
  return out;
}

const WIKIDATA_TIMEOUT_MS = 5000;

/** Fetch + parse a Wikidata entity's OTA ids. Returns {} on any failure
 *  (invalid qid, network/timeout, non-OK, bad JSON) so callers degrade silently. */
export async function resolveWikidataOtaIds(
  qid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WikidataOtaIds> {
  if (!/^Q\d+$/.test(qid)) return {};
  try {
    const res = await fetchImpl(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, {
      signal: AbortSignal.timeout(WIKIDATA_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenMapX/1.0 (+https://openmapx.org)",
      },
    });
    if (!res.ok) return {};
    return parseWikidataOtaIds((await res.json()) as WdEntities, qid);
  } catch {
    return {};
  }
}
