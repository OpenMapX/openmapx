import type { BrandPresence } from "@openmapx/core";
import type { BrandIndex } from "./loader";
import { normalize } from "./normalize";
import type { BrandEntry, BrandKind, BrandMatch } from "./types";

export interface BrandSearchOptions {
  q: string;
  /** Lowercase ISO 3166-1 alpha-2 code of the current viewport, when known. */
  country?: string;
  limit: number;
  /** Keep only identities catalogued with this role (e.g. chains, not operators). */
  kind?: BrandKind;
}

/** NSI's locationSet code for "the whole world". */
const WORLDWIDE = "001";

function presenceOf(entry: BrandEntry, country: string | undefined): BrandPresence {
  if (entry.countries.length === 0) return "unknown";
  if (country && entry.countries.includes(country.toLowerCase())) return "here";
  if (entry.countries.includes(WORLDWIDE)) return "global";
  return country ? "elsewhere" : "unknown";
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
const PRESENCE_RANK: Record<BrandPresence, number> = {
  here: 2,
  global: 2,
  unknown: 1,
  elsewhere: 0,
};

interface ScoredHit {
  entry: BrandEntry;
  score: number;
  matchedOn: BrandMatch["matchedOn"];
}

/** True when `qn` starts one of the words of `name` after the first. */
function startsLaterWord(name: string, qn: string): boolean {
  let space = name.indexOf(" ");
  while (space !== -1) {
    if (name.startsWith(qn, space + 1)) return true;
    space = name.indexOf(" ", space + 1);
  }
  return false;
}

/**
 * Scores `entry` against the normalized query `qn`.
 *
 * Only word starts count: a query inside a word ("rewe" in "brewery") is a
 * coincidence of spelling, not a reference to the chain.
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
    else if (startsLaterWord(name, qn)) base = 300;
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

  const hits: (ScoredHit & { presence: BrandPresence })[] = [];
  for (const entry of index.entries) {
    if (opts.kind && !entry.kind.includes(opts.kind)) continue;
    const hit = scoreEntry(entry, qn);
    if (!hit) continue;
    hits.push({ ...hit, presence: presenceOf(entry, opts.country) });
  }

  // Text score decides first; country and itemCount only break ties within
  // the same score, so a weaker textual match can never outrank a stronger
  // one just for being in the right country.
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      PRESENCE_RANK[b.presence] - PRESENCE_RANK[a.presence] ||
      b.entry.itemCount - a.entry.itemCount,
  );

  const out: BrandMatch[] = [];
  for (const hit of hits) {
    if (out.length >= opts.limit) break;
    const match: BrandMatch = {
      qid: hit.entry.qid,
      name: hit.entry.name,
      kind: hit.entry.kind,
      matchedOn: hit.matchedOn,
      presence: hit.presence,
    };
    if (hit.entry.description) match.description = hit.entry.description;
    if (hit.entry.logoFile) match.logoFile = hit.entry.logoFile;
    out.push(match);
  }
  return out;
}
