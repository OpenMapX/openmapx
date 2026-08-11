import type { BrandIndex } from "./loader";
import { normalize } from "./normalize";
import type { BrandEntry, BrandMatch } from "./types";

export interface BrandSearchOptions {
  q: string;
  /** Lowercase ISO 3166-1 alpha-2 code of the current viewport, when known. */
  country?: string;
  limit: number;
}

/**
 * Country relevance as a sort key rather than a score multiplier.
 *
 * A multiplier scheme has to keep its spread strictly below the smallest
 * adjacent text-tier ratio forever, which is a constraint nobody remembers
 * the next time a base score changes. Ranking on it instead makes "a
 * stronger textual match always wins" true by construction: country and
 * `itemCount` only ever break ties within the same text score.
 *
 * A brand with no country data is global or simply unscoped in NSI; it ranks
 * between "present here" and "present somewhere else" rather than being
 * punished for missing metadata.
 */
function countryRank(entry: BrandEntry, country: string | undefined): number {
  if (!country || entry.countries.length === 0) return 1;
  return entry.countries.includes(country.toLowerCase()) ? 2 : 0;
}

interface ScoredHit {
  entry: BrandEntry;
  score: number;
  matchedOn: BrandMatch["matchedOn"];
}

/**
 * Scores `entry` against the normalized query `qn`.
 *
 * `entry.matchNames` is generated in plain alphabetical order (see
 * `generate.ts`), not canonical-name-first, so `matchNames[0]` cannot be
 * trusted to identify the display name. Classify against the normalized
 * display name explicitly instead — and note it is not guaranteed to appear
 * in `matchNames` at all, so it is scored as its own candidate rather than
 * filtered for.
 */
function scoreEntry(entry: BrandEntry, qn: string): ScoredHit | undefined {
  const canonical = normalize(entry.name);
  const candidates = entry.matchNames.includes(canonical)
    ? entry.matchNames
    : [canonical, ...entry.matchNames];

  let best: ScoredHit | undefined;
  for (const name of candidates) {
    let base: number;
    if (name === qn) base = 1000;
    else if (name.startsWith(qn)) base = 500;
    else if (name.includes(qn)) base = 200;
    else continue;

    const matchedOn: BrandMatch["matchedOn"] = name === canonical ? "name" : "alias";
    // An alias hit is worth slightly less than the same hit on the display name.
    const score = matchedOn === "name" ? base : base * 0.9;
    if (!best || score > best.score) best = { entry, score, matchedOn };
  }
  return best;
}

export function searchBrands(index: BrandIndex, opts: BrandSearchOptions): BrandMatch[] {
  const qn = normalize(opts.q);
  if (qn.length === 0) return [];

  const hits: (ScoredHit & { country: number })[] = [];
  for (const entry of index.entries) {
    const hit = scoreEntry(entry, qn);
    if (!hit) continue;
    hits.push({ ...hit, country: countryRank(entry, opts.country) });
  }

  // Text score decides first; country and itemCount only break ties within
  // the same score, so a weaker textual match can never outrank a stronger
  // one just for being in the right country.
  hits.sort(
    (a, b) => b.score - a.score || b.country - a.country || b.entry.itemCount - a.entry.itemCount,
  );

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
