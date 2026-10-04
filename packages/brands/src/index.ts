import { type BrandIndex, loadBrandIndex } from "./loader";
import { searchBrands } from "./matcher";
import { type BrandNameOptions, matchBrandName, resolveBrandByTags } from "./resolve";
import type { BrandEntry, BrandKind, BrandMatch } from "./types";

// Built once per process on first use. The artifact is ~6 MB of JSON; parsing
// it costs ~100 ms, so the first caller pays and everyone after reads the Map.
let cachedIndex: BrandIndex | undefined;

function getIndex(): BrandIndex {
  if (!cachedIndex) cachedIndex = loadBrandIndex();
  return cachedIndex;
}

/** Warms the index off the request path. Safe to call more than once. */
export function warmBrandIndex(): void {
  getIndex();
}

export function suggestBrands(
  q: string,
  country: string | undefined,
  limit: number,
  kind?: BrandKind,
): BrandMatch[] {
  return searchBrands(getIndex(), {
    q,
    country: country?.toLowerCase(),
    limit: Math.min(Math.max(limit, 1), 20),
    kind,
  });
}

export function getBrandByQid(qid: string): BrandEntry | undefined {
  return getIndex().byQid.get(qid);
}

export function resolveBrand(tags: Record<string, string> | undefined): BrandEntry | undefined {
  return resolveBrandByTags(getIndex(), tags);
}

/**
 * Resolves a plain brand name to its catalog entry — exact normalized match
 * within `opts.tagSet`, disambiguated by `opts.country`. Undefined when the
 * name is unknown or stays ambiguous.
 */
export function resolveBrandByName(name: string, opts: BrandNameOptions): BrandEntry | undefined {
  return matchBrandName(getIndex(), name, opts);
}

/** NSI version behind the catalog, for attribution surfaces. */
export function brandCatalogSource(): string {
  return getIndex().source;
}

export type { BrandNameOptions } from "./resolve";
export type { BrandEntry, BrandMatch } from "./types";
