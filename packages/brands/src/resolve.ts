import { BRAND_QID_KEYS } from "@openmapx/core";
import type { BrandIndex } from "./loader";
import { normalize } from "./normalize";
import type { BrandEntry } from "./types";

/** NSI's locationSet code for "the whole world". */
const WORLDWIDE = "001";

export interface BrandNameOptions {
  /** Primary OSM tag set the brand must be catalogued with, e.g. "amenity=fuel". */
  tagSet: string;
  /** ISO 3166-1 alpha-2 code of where the named place is, in any case. */
  country?: string;
}

/** Normalized match name → the entries carrying it, for one tag set. */
export type BrandNameIndex = ReadonlyMap<string, readonly BrandEntry[]>;

// Built lazily per catalog and tag set on first lookup, so a name lookup is a
// Map read instead of a scan over every catalogued brand.
const nameIndexes = new WeakMap<BrandIndex, Map<string, BrandNameIndex>>();

/** The name lookup for `tagSet` over `index`, built once and reused. */
export function brandNameIndex(index: BrandIndex, tagSet: string): BrandNameIndex {
  let byTagSet = nameIndexes.get(index);
  if (!byTagSet) {
    byTagSet = new Map();
    nameIndexes.set(index, byTagSet);
  }
  const cached = byTagSet.get(tagSet);
  if (cached) return cached;

  const byName = new Map<string, BrandEntry[]>();
  for (const entry of index.entries) {
    if (!entry.tagSets.includes(tagSet)) continue;
    for (const name of new Set(entry.matchNames)) {
      const list = byName.get(name);
      if (list) list.push(entry);
      else byName.set(name, [entry]);
    }
  }
  byTagSet.set(tagSet, byName);
  return byName;
}

function presentIn(entry: BrandEntry, country: string): boolean {
  return (
    entry.countries.length === 0 ||
    entry.countries.includes(WORLDWIDE) ||
    entry.countries.includes(country)
  );
}

/**
 * Finds the catalogued identity behind a plain brand name a feed published.
 *
 * Deterministic and deliberately narrow: the normalized name must equal one of
 * an entry's `matchNames` and the entry must be catalogued with `opts.tagSet`.
 * With `opts.country`, only entries present there (or worldwide, or without
 * country data) count — a brand catalogued only elsewhere is not this one.
 * Anything but exactly one survivor is no answer: a guessed brand is worse
 * than none.
 */
export function matchBrandName(
  index: BrandIndex,
  name: string,
  opts: BrandNameOptions,
): BrandEntry | undefined {
  const wanted = normalize(name);
  if (wanted.length === 0) return undefined;
  const candidates = brandNameIndex(index, opts.tagSet).get(wanted) ?? [];
  const country = opts.country?.toLowerCase();
  const present = country ? candidates.filter((entry) => presentIn(entry, country)) : candidates;
  return present.length === 1 ? present[0] : undefined;
}

/**
 * Finds the catalogued identity behind a POI's tags.
 *
 * QID keys are checked first and in precedence order; a QID is unambiguous
 * where a name is not. There is deliberately no name-based fallback here —
 * matching "Star" by name across 26k brands produces confident wrong answers.
 */
export function resolveBrandByTags(
  index: BrandIndex,
  tags: Record<string, string> | undefined,
): BrandEntry | undefined {
  if (!tags) return undefined;
  for (const key of BRAND_QID_KEYS) {
    const qid = tags[key];
    if (qid) {
      const entry = index.byQid.get(qid);
      if (entry) return entry;
    }
  }
  return undefined;
}
