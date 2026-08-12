import {
  isUppercaseAcronymIntent,
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
  osm_type: "node" | "way" | "relation";
  osm_id: string | number;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  tags: Record<string, string> | null;
  importance: number;
  display_value: string;
  normalized_term: string;
  kind: SearchSuggestion["searchMatch"]["kind"];
  namespace: string | null;
}

const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  attributionText: "© OpenStreetMap contributors",
};

const SEARCH_SQL = `
SELECT p.osm_type, p.osm_id::TEXT AS osm_id, p.name, p.lat, p.lng, p.category,
       p.tags, p.importance, t.display_value, t.normalized_term, t.kind, t.namespace
FROM osm_search.terms AS t
JOIN osm_search.places AS p USING (osm_type, osm_id)
WHERE (t.normalized_term = $1
   OR ($2::BOOLEAN AND t.kind IN ('explicit_alias', 'explicit_reference', 'authoritative_code')
       AND t.normalized_term LIKE $1 || '%'))
  AND (t.kind <> 'generated_acronym'
       OR $6::BOOLEAN
       OR p.importance >= 0.8
       OR ($4::DOUBLE PRECISION IS NOT NULL AND $5::DOUBLE PRECISION IS NOT NULL
           AND ST_DWithin(
             p.geom,
             ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
             100000
           )))
ORDER BY
  CASE t.kind
    WHEN 'authoritative_code' THEN 4
    WHEN 'explicit_reference' THEN 3
    WHEN 'explicit_alias' THEN 3
    WHEN 'generated_acronym' THEN 1
  END DESC,
  p.importance DESC,
  CASE WHEN $4::DOUBLE PRECISION IS NULL OR $5::DOUBLE PRECISION IS NULL THEN 0
       ELSE ST_Distance(
         p.geom,
         ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography
       )
  END ASC,
  p.name ASC,
  p.osm_type ASC,
  p.osm_id ASC
LIMIT $3`;

function allowsPrefix(query: string): boolean {
  if (query.length >= 3) return true;
  return query.length >= 2 && /^[\p{L}\p{N}]+$/u.test(query);
}

function mapRow(row: SearchRow): SearchSuggestion {
  const osmValue = `${row.osm_type}/${row.osm_id}`;
  const wikidata = row.tags?.wikidata;
  return {
    id: `osm:${osmValue}`,
    ids: { osm: osmValue, ...(wikidata ? { wikidata } : {}) },
    label: row.name,
    coordinates: [Number(row.lng), Number(row.lat)],
    type: "poi",
    rawCategory: row.category ?? undefined,
    searchMatch: {
      kind: row.kind,
      value: row.display_value,
      normalized: row.normalized_term,
      namespace: row.namespace ?? undefined,
    },
    importance: Number(row.importance),
    provider: "search-osm-aliases",
    contributingProviders: ["search-osm-aliases"],
  };
}

export function createOsmAliasSuggestionProvider(
  ctx: IntegrationContext,
): SearchSuggestionProvider {
  return {
    id: "search-osm-aliases",
    async searchSuggestions(query: SearchSuggestionQuery): Promise<SearchSuggestionProviderResult> {
      if (!ctx.db) return { suggestions: [], attributions: [], freshnessSeconds: 86_400 };
      const states = await ctx.db.execute<IndexStateRow[]>(
        "SELECT epoch, status FROM osm_search.index_state WHERE singleton = 1",
      );
      const state = states[0];
      if (state?.status !== "ready") {
        return { suggestions: [], attributions: [], freshnessSeconds: 86_400 };
      }
      const normalized = normalizeSearchTerm(query.query);
      const proximity = query.proximity;
      const key = [
        "osm-alias",
        state.epoch,
        normalized,
        query.lang,
        proximity?.map((value) => Math.round(value * 100) / 100).join(",") ?? "none",
        isUppercaseAcronymIntent(query.query) ? "upper" : "lower",
        query.limit,
      ].join(":");
      return ctx.cache.withCache(key, 86_400, async () => {
        const rows = await ctx.db?.execute<SearchRow[]>(SEARCH_SQL, [
          normalized,
          allowsPrefix(normalized),
          query.limit,
          proximity?.[0] ?? null,
          proximity?.[1] ?? null,
          isUppercaseAcronymIntent(query.query),
        ]);
        const suggestions = (rows ?? []).map(mapRow);
        return {
          suggestions,
          attributions: suggestions.length > 0 ? [OSM_ATTRIBUTION] : [],
          freshnessSeconds: 86_400,
        };
      });
    },
  };
}
