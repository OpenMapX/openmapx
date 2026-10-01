import {
  editDistance,
  MIN_NEAR_SPELLING_LENGTH,
  nearSpellingEdits,
  normalizeSearchTerm,
  type SearchSuggestion,
  type SearchSuggestionProviderResult,
  type SearchSuggestionQuery,
} from "@openmapx/core";
import type { IntegrationContext, SearchSuggestionProvider } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";

interface IndexStateRow {
  epoch: string;
  status: string;
}

interface SearchRow {
  qid: string;
  kind: "place" | "settlement";
  lat: number;
  lng: number;
  fame: number;
  iata: string | null;
  icao: string | null;
  matched: string;
  normalized: string;
  label: string;
  /** Its full names in the other stored languages, Wikidata's own first. */
  otherLabels: string[] | null;
  description: string | null;
}

const WIKIDATA_ATTRIBUTION: Attribution = {
  sourceId: "wikidata",
  name: "Wikidata",
  url: "https://www.wikidata.org/",
  spdxLicense: "CC0-1.0",
  licenseUrl: "https://www.wikidata.org/wiki/Wikidata:Licensing",
  attributionText: "Wikidata",
};

/** Settlements in the index are cities known worldwide, ranked as geocoders rank a city. */
const SETTLEMENT_RAW_CATEGORY = "place/city";

/** Below this a query starts too many names to say anything about fame. */
export const MIN_NOTABLE_QUERY_LENGTH = 3;

/**
 * Each place once, by the name the query matches best (the whole name over
 * one it only starts), labelled in the app's language. A city only by a whole
 * name: geocoders complete the start of a city's name themselves, and the
 * starts of its nicknames would bring up Nîmes, "la Rome française", for
 * "rom". Ordered so that a place named exactly comes first and, among the
 * rest, fame and nearness share the say: within the limit, a moderately known
 * place near the map still makes it next to a world-famous one far away.
 */
const MATCHED_PLACES = `
SELECT p.qid, p.kind, p.lat, p.lng, p.fame, p.iata, p.icao, m.name AS matched, m.normalized,
       COALESCE(own.name, mul.name, en.name, m.name) AS label,
       ARRAY(SELECT other.name FROM notable_places.labels AS other
              WHERE other.qid = p.qid
              ORDER BY other.lang = 'mul' DESC, other.lang) AS "otherLabels",
       COALESCE(own_description.description, en_description.description) AS description
  FROM matched AS m
  JOIN notable_places.places AS p USING (qid)
  LEFT JOIN notable_places.labels AS own ON own.qid = p.qid AND own.lang = $3
  LEFT JOIN notable_places.labels AS mul ON mul.qid = p.qid AND mul.lang = 'mul'
  LEFT JOIN notable_places.labels AS en ON en.qid = p.qid AND en.lang = 'en'
  LEFT JOIN notable_places.descriptions AS own_description
         ON own_description.qid = p.qid AND own_description.lang = $3
  LEFT JOIN notable_places.descriptions AS en_description
         ON en_description.qid = p.qid AND en_description.lang = 'en'`;

const SEARCH_SQL = `
WITH matched AS (
  SELECT DISTINCT ON (n.qid) n.qid, n.name, n.normalized
    FROM notable_places.names AS n
    JOIN notable_places.places AS p USING (qid)
   WHERE n.normalized = $1 OR (n.normalized LIKE $1 || '%' AND p.kind = 'place')
   ORDER BY n.qid, (n.normalized = $1) DESC, length(n.normalized)
)
${MATCHED_PLACES}
 ORDER BY (m.normalized = $1) DESC,
          p.fame + CASE
            WHEN $4::DOUBLE PRECISION IS NULL OR $5::DOUBLE PRECISION IS NULL THEN 0
            ELSE 0.5 / (1 + ST_Distance(
              p.geom, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography) / 50000)
          END DESC,
          p.qid
 LIMIT $2`;

/**
 * Places with a name spelled close to the text, for text that names none
 * exactly: "neuschwanstien", "eifel tower", "sagrada famila". Trigrams find
 * candidates; the edit distance, counted only for names of about the text's
 * length, keeps the near ones. Fewest slips first, then the best known.
 * Cities are left to the geocoders, as their name starts are.
 */
const NEAR_SQL = `
WITH candidates AS (
  SELECT n.qid, n.name, n.normalized,
         CASE WHEN abs(length(n.normalized) - length($1)) <= $4
              THEN levenshtein_less_equal(n.normalized, $1, $4) END AS edits
    FROM notable_places.names AS n
    JOIN notable_places.places AS p USING (qid)
   WHERE n.normalized % $1 AND p.kind = 'place'
), matched AS (
  SELECT DISTINCT ON (c.qid) c.qid, c.name, c.normalized, c.edits
    FROM candidates AS c
   WHERE c.edits <= $4
   ORDER BY c.qid, c.edits, similarity(c.normalized, $1) DESC
)
${MATCHED_PLACES}
 ORDER BY m.edits, p.fame DESC, p.qid
 LIMIT $2`;

/** Near spellings offered at most, next to what the text names as typed. */
const NEAR_LIMIT = 3;
/** Longer text is no name typed with a slip; edit distance stops at 255 characters. */
const MAX_NEAR_SPELLING_LENGTH = 100;

/**
 * For a near spelling, whichever of the place's names the text is close to,
 * so the row reads as what was meant: Sagrada Família for "sagrada famila",
 * not the basilica's long English name.
 */
function nearDisplayName(row: SearchRow, normalizedQuery: string): string {
  const edits = nearSpellingEdits(normalizedQuery);
  const near = (name: string) =>
    editDistance(normalizeSearchTerm(name), normalizedQuery, edits) <= edits;
  return [row.label, ...(row.otherLabels ?? [])].find(near) ?? row.matched;
}

/**
 * The place's name in the app's language, unless that leaves out what was
 * typed. Then its full name in another language that has it: "sagrada
 * familia" shows Sagrada Família, not "Basilica and Expiatory Church of the
 * Holy Family", and "münchen" shows Flughafen München for the airport, not
 * the bare alias "München", which reads as the city. Only then the name that
 * matched. A code that matched ("LAX") is no name to show, nor is a city's
 * other name ("Köln", "Big Apple"): the label stays, and the row shows what
 * matched beside it.
 */
function displayName(row: SearchRow, normalizedQuery: string): string {
  if (row.kind === "settlement") return row.label;
  const holdsQuery = (name: string) => normalizeSearchTerm(name).includes(normalizedQuery);
  if (holdsQuery(row.label)) return row.label;
  const fullName = row.otherLabels?.find(holdsQuery);
  if (fullName) return fullName;
  return /^[A-Z0-9]{2,5}$/.test(row.matched) ? row.label : row.matched;
}

function mapRow(row: SearchRow, normalizedQuery: string, near = false): SearchSuggestion {
  const fame = Number(row.fame);
  const label = near ? nearDisplayName(row, normalizedQuery) : displayName(row, normalizedQuery);
  return {
    id: `wikidata:${row.qid}`,
    // Airport codes join this row to the airport catalog's row for the same place.
    ids: {
      wikidata: row.qid,
      ...(row.iata ? { iata: row.iata } : {}),
      ...(row.icao ? { icao: row.icao } : {}),
    },
    label,
    ...(row.description ? { sublabel: row.description } : {}),
    coordinates: [Number(row.lng), Number(row.lat)],
    // A city is an area like a geocoder's row for it, which it then joins.
    ...(row.kind === "settlement"
      ? { type: "region" as const, rawCategory: SETTLEMENT_RAW_CATEGORY }
      : { type: "poi" as const }),
    // A near spelling matched the name it shows, so no other name is shown beside it.
    searchMatch: near
      ? { kind: "near_name", value: label, normalized: normalizeSearchTerm(label) }
      : { kind: "name", value: row.matched, normalized: row.normalized },
    importance: fame,
    fame,
    provider: "search-notable-places",
    contributingProviders: ["search-notable-places"],
  };
}

/**
 * Places known well beyond their own town, by name in any of the indexed
 * languages, with how widely known each is. It answers what a geocoder's
 * ranking cannot: that "louvre" from Berlin means the museum in Paris, not
 * the bar of that name down the road.
 */
export function createNotablePlacesSuggestionProvider(
  ctx: IntegrationContext,
): SearchSuggestionProvider {
  return {
    id: "search-notable-places",
    async searchSuggestions(
      query: SearchSuggestionQuery,
      { signal },
    ): Promise<SearchSuggestionProviderResult> {
      signal.throwIfAborted();
      const empty = { suggestions: [], attributions: [], freshnessSeconds: 86_400 };
      const normalized = normalizeSearchTerm(query.query);
      if (!ctx.db || normalized.length < MIN_NOTABLE_QUERY_LENGTH) return empty;
      // Until the data-manager publishes a first snapshot there is no schema
      // to read, which is not a fault of the provider.
      const published = await ctx.db.execute<{ exists: boolean }[]>(
        "SELECT to_regclass('notable_places.index_state') IS NOT NULL AS exists",
        undefined,
        { signal },
      );
      if (!published[0]?.exists) return empty;
      const states = await ctx.db.execute<IndexStateRow[]>(
        "SELECT epoch, status FROM notable_places.index_state WHERE singleton = 1",
        undefined,
        { signal },
      );
      const state = states[0];
      if (state?.status !== "ready") return empty;
      const proximity = query.proximity;
      const key = [
        "notable-places",
        state.epoch,
        normalized,
        query.lang,
        proximity?.map((value) => Math.round(value * 10) / 10).join(",") ?? "none",
        query.limit,
      ].join(":");
      return ctx.cache.withCache(key, 86_400, async () => {
        signal.throwIfAborted();
        const rows = await ctx.db?.execute<SearchRow[]>(
          SEARCH_SQL,
          [normalized, query.limit, query.lang, proximity?.[0] ?? null, proximity?.[1] ?? null],
          { signal },
        );
        const found = rows ?? [];
        const suggestions = found.map((row) => mapRow(row, normalized));
        // Text that names nothing exactly may be a famous name with a slip.
        if (
          normalized.length >= MIN_NEAR_SPELLING_LENGTH &&
          normalized.length <= MAX_NEAR_SPELLING_LENGTH &&
          !found.some((row) => row.normalized === normalized)
        ) {
          const nearRows = await ctx.db?.execute<SearchRow[]>(
            NEAR_SQL,
            [normalized, NEAR_LIMIT, query.lang, nearSpellingEdits(normalized)],
            { signal },
          );
          const listed = new Set(found.map((row) => row.qid));
          for (const row of nearRows ?? []) {
            if (!listed.has(row.qid)) suggestions.push(mapRow(row, normalized, true));
          }
        }
        return {
          suggestions,
          attributions: suggestions.length > 0 ? [WIKIDATA_ATTRIBUTION] : [],
          freshnessSeconds: 86_400,
        };
      });
    },
  };
}
