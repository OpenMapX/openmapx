import type { PresetIndexEntry, PresetMatch } from "./types";

interface SearchOptions {
  q: string;
  lang: string;
  limit: number;
  /** Set of canonical tag-set strings that should be suppressed (e.g. chip-bar duplicates). */
  suppressTagSets: ReadonlySet<string>;
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Canonical, deterministic representation of a tag set for equality comparison. */
export function canonicalTagSet(tags: Record<string, string>): string {
  const pairs = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(pairs);
}

interface ScoredHit {
  entry: PresetIndexEntry;
  score: number;
  matchedOn: PresetMatch["matchedOn"];
}

function scoreEntry(entry: PresetIndexEntry, qn: string): ScoredHit | undefined {
  if (entry.normalizedName === qn) {
    return { entry, score: 1000 * entry.matchScore, matchedOn: "name" };
  }
  if (entry.normalizedName.startsWith(qn)) {
    return { entry, score: 500 * entry.matchScore, matchedOn: "name" };
  }
  if (entry.normalizedName.includes(qn)) {
    return { entry, score: 250 * entry.matchScore, matchedOn: "name" };
  }
  if (entry.normalizedAliases.includes(qn)) {
    return { entry, score: 200 * entry.matchScore, matchedOn: "alias" };
  }
  if (entry.normalizedAliases.some((a) => a.startsWith(qn))) {
    return { entry, score: 150 * entry.matchScore, matchedOn: "alias" };
  }
  if (entry.normalizedTerms.includes(qn)) {
    return { entry, score: 100 * entry.matchScore, matchedOn: "term" };
  }
  if (entry.normalizedTerms.some((t) => t.includes(qn))) {
    return { entry, score: 50 * entry.matchScore, matchedOn: "term" };
  }
  return undefined;
}

export function searchPresets(
  index: ReadonlyMap<string, readonly PresetIndexEntry[]>,
  opts: SearchOptions,
): PresetMatch[] {
  const qn = normalize(opts.q);
  if (qn.length === 0) return [];

  const slice = index.get(opts.lang) ?? index.get("en") ?? [];

  const hits: ScoredHit[] = [];
  for (const entry of slice) {
    if (opts.suppressTagSets.has(canonicalTagSet(entry.tags))) continue;
    const hit = scoreEntry(entry, qn);
    if (hit) hits.push(hit);
  }

  hits.sort((a, b) => b.score - a.score);

  const out: PresetMatch[] = [];
  for (const hit of hits) {
    if (out.length >= opts.limit) break;
    out.push({
      id: hit.entry.presetId,
      name: hit.entry.displayName,
      iconKey: hit.entry.icon,
      tags: hit.entry.tags,
      matchedOn: hit.matchedOn,
    });
  }
  return out;
}
