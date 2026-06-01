// integrations/hotels/wikidata.ts
/** OTA hotel ids resolved from a Wikidata entity (any subset may be present). */
export interface WikidataOtaIds {
  expedia?: string; // P5651, e.g. "h7172034"
  booking?: string; // P3607, e.g. "eg/windsor-palace"
  hotelscom?: string; // P3898
  // Agoda: only the P6008 slug builds a working hotel URL (`/<slug>.html`); the
  // P10533 numeric id is NOT deep-linkable (it needs a session-signed token), so
  // it is intentionally not read here.
  agoda?: string; // P6008 (slug)
  tripcom?: string; // P10425 (numeric)
}

const PROP: Record<keyof WikidataOtaIds, string> = {
  expedia: "P5651",
  booking: "P3607",
  hotelscom: "P3898",
  agoda: "P6008",
  tripcom: "P10425",
};

interface WdStatement {
  mainsnak?: { datavalue?: { value?: unknown } };
  /** "preferred" | "normal" | "deprecated" — present on real statements. */
  rank?: string;
}
interface WdEntities {
  entities?: Record<string, { claims?: Record<string, WdStatement[]> }>;
}

/**
 * String value of a Wikidata external-id claim, respecting statement rank: a
 * "preferred" statement wins, "deprecated" ones are skipped, otherwise the
 * first normal value. Statements arrive in edit order (not rank order), so a
 * stale/deprecated first statement must not be taken as authoritative.
 */
function claimValue(
  claims: Record<string, WdStatement[]> | undefined,
  prop: string,
): string | undefined {
  const statements = claims?.[prop];
  if (!statements?.length) return undefined;
  const value = (st: WdStatement | undefined): string | undefined => {
    const v = st?.mainsnak?.datavalue?.value;
    return typeof v === "string" ? v : undefined;
  };
  const preferred = value(statements.find((s) => s.rank === "preferred"));
  if (preferred) return preferred;
  for (const s of statements) {
    if (s.rank === "deprecated") continue;
    const v = value(s);
    if (v) return v;
  }
  return undefined;
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

/**
 * Fetch + parse a Wikidata entity's OTA ids. Distinguishes a GENUINE empty
 * result from a TRANSIENT failure so callers can cache the former but retry the
 * latter:
 *   - invalid qid  → `{}`   (deterministically empty — safe to cache)
 *   - success      → parsed ids (possibly `{}` if the entity has no OTA claims)
 *   - network/timeout/non-OK/bad-JSON → `null` (transient — do NOT cache)
 */
export async function resolveWikidataOtaIds(
  qid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WikidataOtaIds | null> {
  if (!/^Q\d+$/.test(qid)) return {};
  try {
    const res = await fetchImpl(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, {
      signal: AbortSignal.timeout(WIKIDATA_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenMapX/1.0 (+https://openmapx.org)",
      },
    });
    if (!res.ok) return null;
    return parseWikidataOtaIds((await res.json()) as WdEntities, qid);
  } catch {
    return null;
  }
}
