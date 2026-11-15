import type { LngLat } from "../types/geometry";
import { haversineDistance } from "./coordinates";
import { normalizeName } from "./geo-server";

/** How far apart, in metres, a place and a data-source item may be and still be one site. */
export const DATA_SOURCE_MATCH_METERS = 100;

/** A place to find in a data source's results. */
export interface DataSourceMatchCandidate {
  id: string;
  coordinates: LngLat;
  /** The place's brand, when its source names one. */
  brand?: string;
}

/** The parts of a data-source result the match reads. */
export interface DataSourceMatchTarget {
  id: string;
  coordinates: LngLat;
  /** The brand or operator the data source names. */
  operator?: string;
}

function brandKey(brand: string): string {
  return normalizeName(brand).replaceAll(" ", "");
}

/**
 * Whether two brand names may name the same site: equal once case, spacing and
 * punctuation are ignored, or one a prefix of the other ("Shell" and "Shell
 * Deutschland"). A side without a brand rules nothing out.
 */
function brandsAgree(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  const left = brandKey(a);
  const right = brandKey(b);
  if (!left || !right) return true;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Pairs places with the data-source results that describe the same site: the
 * closest result within {@link DATA_SOURCE_MATCH_METERS}, each result given to
 * at most one place. Pairs are taken closest first, so of two stations across
 * a road each keeps the result beside it, and a station the source lacks gets
 * no result rather than its neighbour's. A pair whose brands disagree is never
 * taken. Returns the matched result by place id.
 */
export function matchDataSourceResults<T extends DataSourceMatchTarget>(
  candidates: readonly DataSourceMatchCandidate[],
  results: readonly T[],
  maxMeters: number = DATA_SOURCE_MATCH_METERS,
): Map<string, T> {
  const pairs: { candidate: number; result: number; meters: number }[] = [];
  for (const [ci, candidate] of candidates.entries()) {
    for (const [ri, result] of results.entries()) {
      const meters = haversineDistance(candidate.coordinates, result.coordinates);
      if (meters > maxMeters || !brandsAgree(candidate.brand, result.operator)) continue;
      pairs.push({ candidate: ci, result: ri, meters });
    }
  }
  pairs.sort((a, b) => a.meters - b.meters || a.candidate - b.candidate || a.result - b.result);
  const matches = new Map<string, T>();
  const taken = new Set<number>();
  for (const pair of pairs) {
    const candidate = candidates[pair.candidate];
    if (matches.has(candidate.id) || taken.has(pair.result)) continue;
    matches.set(candidate.id, results[pair.result]);
    taken.add(pair.result);
  }
  return matches;
}
