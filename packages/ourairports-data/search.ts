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

  return {
    byCode(code) {
      const trimmed = code.trim().toUpperCase();
      return byCodeMap.get(trimmed) ?? null;
    },
    query(q, limit = 10) {
      const trimmed = q.trim();
      if (trimmed.length === 0) return [];
      const queryLower = trimmed.toLowerCase();
      const queryUpper = trimmed.toUpperCase();
      const ranked: Array<{ rank: number; typeRank: number; record: AirportRecord }> = [];
      const seen = new Set<number>();

      // Exact IATA/ICAO/ident hit — always wins.
      const exact = byCodeMap.get(queryUpper);
      if (exact) {
        ranked.push({
          rank: RANK_EXACT_CODE,
          typeRank: TYPE_RANK[exact.type] ?? 99,
          record: exact,
        });
        seen.add(exact.id);
      }

      // Otherwise: walk all entries and bucket by match strength.
      for (const e of entries) {
        if (seen.has(e.record.id)) continue;
        let rank: number | null = null;
        if (e.nameLower.startsWith(queryLower)) {
          rank = RANK_NAME_PREFIX;
        } else if (e.nameLower.includes(queryLower)) {
          rank = RANK_NAME_CONTAINS;
        } else if (e.keywordsLower.includes(queryLower)) {
          rank = RANK_KEYWORD_MATCH;
        }
        if (rank !== null) {
          ranked.push({
            rank,
            typeRank: TYPE_RANK[e.record.type] ?? 99,
            record: e.record,
          });
          seen.add(e.record.id);
        }
        // Early exit: once we have many candidates ranked, we'll sort + cap;
        // bail out if we have plenty of name-prefix and name-contains hits.
        if (ranked.length >= limit * 20) break;
      }

      ranked.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank;
        return a.record.name.localeCompare(b.record.name);
      });

      return ranked.slice(0, limit).map((r) => r.record);
    },
  };
}
