import type { AirportRecord } from "./types.js";

/**
 * Search index over the airport catalog. Provides exact-match lookup by
 * IATA/ICAO/ident codes and substring / token match on name + keywords.
 */
export interface SearchIndex {
  /** Exact-match by IATA, ICAO, ident, gpsCode, or localCode (uppercased). */
  byCode(code: string): AirportRecord | null;
  /**
   * Substring / token-prefix search over name + keywords. Results ranked by:
   * 1. Exact IATA/ICAO/ident code match (highest)
   * 2. Name starts with the query
   * 3. Name contains the query
   * 4. Keyword tokens contain the query
   * Within each tier, large airports rank above medium / small / heliport.
   */
  query(q: string, limit?: number): AirportRecord[];
  /** Search while retaining the field/value that caused each match. */
  queryMatches(q: string, limit?: number): AirportSearchMatch[];
}

export interface AirportSearchMatch {
  record: AirportRecord;
  kind: "authoritative_code" | "name" | "explicit_alias";
  matchedValue: string;
  namespace?: "iata" | "icao" | "ident" | "gps_code" | "local_code";
}

const TYPE_RANK: Record<string, number> = {
  large_airport: 0,
  medium_airport: 1,
  small_airport: 2,
  seaplane_base: 3,
  heliport: 4,
  balloonport: 5,
  closed_airport: 6,
};

const RANK_EXACT_CODE = 0;
const RANK_NAME_PREFIX = 1;
const RANK_NAME_CONTAINS = 2;
const RANK_KEYWORD_MATCH = 3;

interface IndexEntry {
  record: AirportRecord;
  /** Lowercase name for substring search. */
  nameLower: string;
  /** Lowercase keyword string for substring search. */
  keywordsLower: string;
}

export function buildSearchIndex(records: AirportRecord[]): SearchIndex {
  const byCodeMap = new Map<string, AirportRecord>();
  const entries: IndexEntry[] = [];
  for (const r of records) {
    if (r.iata) byCodeMap.set(r.iata, r);
    if (r.icao) byCodeMap.set(r.icao, r);
    if (r.ident && !byCodeMap.has(r.ident)) byCodeMap.set(r.ident, r);
    if (r.gpsCode && !byCodeMap.has(r.gpsCode)) byCodeMap.set(r.gpsCode, r);
    if (r.localCode && !byCodeMap.has(r.localCode)) byCodeMap.set(r.localCode, r);
    entries.push({
      record: r,
      nameLower: r.name.toLowerCase(),
      keywordsLower: r.keywords?.toLowerCase() ?? "",
    });
  }

  function queryMatches(q: string, limit = 10): AirportSearchMatch[] {
    const trimmed = q.trim();
    if (trimmed.length === 0) return [];
    const queryLower = trimmed.toLowerCase();
    const queryUpper = trimmed.toUpperCase();
    const ranked: Array<{
      rank: number;
      typeRank: number;
      match: AirportSearchMatch;
    }> = [];
    const seen = new Set<number>();

    const exact = byCodeMap.get(queryUpper);
    if (exact) {
      const codeFields = [
        ["iata", exact.iata],
        ["icao", exact.icao],
        ["ident", exact.ident],
        ["gps_code", exact.gpsCode],
        ["local_code", exact.localCode],
      ] as const;
      const evidence = codeFields.find(([, value]) => value?.toUpperCase() === queryUpper);
      ranked.push({
        rank: RANK_EXACT_CODE,
        typeRank: TYPE_RANK[exact.type] ?? 99,
        match: {
          record: exact,
          kind: "authoritative_code",
          matchedValue: evidence?.[1] ?? queryUpper,
          namespace: evidence?.[0],
        },
      });
      seen.add(exact.id);
    }

    for (const entry of entries) {
      if (seen.has(entry.record.id)) continue;
      let rank: number | null = null;
      let kind: AirportSearchMatch["kind"] = "name";
      let matchedValue = entry.record.name;
      if (entry.nameLower.startsWith(queryLower)) {
        rank = RANK_NAME_PREFIX;
      } else if (entry.nameLower.includes(queryLower)) {
        rank = RANK_NAME_CONTAINS;
      } else if (entry.keywordsLower.includes(queryLower)) {
        rank = RANK_KEYWORD_MATCH;
        kind = "explicit_alias";
        matchedValue =
          entry.record.keywords
            ?.split(",")
            .map((value) => value.trim())
            .find((value) => value.toLowerCase().includes(queryLower)) ?? trimmed;
      }
      if (rank !== null) {
        ranked.push({
          rank,
          typeRank: TYPE_RANK[entry.record.type] ?? 99,
          match: { record: entry.record, kind, matchedValue },
        });
        seen.add(entry.record.id);
      }
      if (ranked.length >= limit * 20) break;
    }

    ranked.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank;
      return a.match.record.name.localeCompare(b.match.record.name);
    });
    return ranked.slice(0, limit).map(({ match }) => match);
  }

  return {
    byCode(code) {
      const trimmed = code.trim().toUpperCase();
      return byCodeMap.get(trimmed) ?? null;
    },
    query(q, limit = 10) {
      return queryMatches(q, limit).map(({ record }) => record);
    },
    queryMatches,
  };
}
