import type { BrandIndex } from "./loader";
import type { BrandEntry, BrandMatch } from "./types";

export interface BrandSearchOptions {
  q: string;
  /** Lowercase ISO 3166-1 alpha-2 code of the current viewport, when known. */
  country?: string;
  limit: number;
}

/** Mirrors the normalization the generator applied to `matchNames`. */
function normalize(input: string): string {
  return input.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Country relevance, applied as a multiplier rather than an additive bonus so a
 * weak textual match in the right country never outranks a strong one.
 *
 * A brand with no country data is global or simply unscoped in NSI; it sits
 * between "present here" and "present somewhere else" instead of being punished
 * for missing metadata.
 */
function countryWeight(entry: BrandEntry, country: string | undefined): number {
  if (!country || entry.countries.length === 0) return 1;
  return entry.countries.includes(country) ? 4 : 0.25;
}

interface ScoredHit {
  entry: BrandEntry;
  score: number;
  matchedOn: BrandMatch["matchedOn"];
}

function scoreEntry(entry: BrandEntry, qn: string): ScoredHit | undefined {
  const primary = entry.matchNames[0];
  const isPrimary = (name: string) => name === primary || normalize(entry.name) === name;

  let best: ScoredHit | undefined;
  for (const name of entry.matchNames) {
    let base: number;
    if (name === qn) base = 1000;
    else if (name.startsWith(qn)) base = 500;
    else if (name.includes(qn)) base = 200;
    else continue;

    const matchedOn: BrandMatch["matchedOn"] = isPrimary(name) ? "name" : "alias";
    // An alias hit is worth slightly less than the same hit on the display name.
    const score = matchedOn === "name" ? base : base * 0.9;
    if (!best || score > best.score) best = { entry, score, matchedOn };
  }
  return best;
}

export function searchBrands(index: BrandIndex, opts: BrandSearchOptions): BrandMatch[] {
  const qn = normalize(opts.q);
  if (qn.length === 0) return [];

  const hits: ScoredHit[] = [];
  for (const entry of index.entries) {
    const hit = scoreEntry(entry, qn);
    if (!hit) continue;
    hits.push({ ...hit, score: hit.score * countryWeight(entry, opts.country) });
  }

  // itemCount breaks ties: a chain NSI catalogues across more categories and
  // regions is the bigger chain, and the one a user is more likely to mean.
  hits.sort((a, b) => b.score - a.score || b.entry.itemCount - a.entry.itemCount);

  const out: BrandMatch[] = [];
  for (const hit of hits) {
    if (out.length >= opts.limit) break;
    const match: BrandMatch = {
      qid: hit.entry.qid,
      name: hit.entry.name,
      kind: hit.entry.kind,
      matchedOn: hit.matchedOn,
    };
    if (hit.entry.description) match.description = hit.entry.description;
    if (hit.entry.logoFile) match.logoFile = hit.entry.logoFile;
    out.push(match);
  }
  return out;
}
