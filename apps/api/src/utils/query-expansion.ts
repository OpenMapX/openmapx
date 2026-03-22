/**
 * Bidirectional transit synonym expansion for geocoding queries.
 *
 * Geocoding indexes may store a station as "Aachen Hbf" or "Aachen Hauptbahnhof".
 * This module generates both variants so results are found regardless of which
 * form the user types. The canonical (fully-expanded) form is used for cache keys
 * so that both inputs share a single cache slot.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bidirectional synonym pairs: [short form, long form].
 * Word-bounded matching ensures "Bf" doesn't match inside "Busbahnhof".
 */
const SYNONYM_PAIRS: [string, string][] = [
  // German
  ["Hbf", "Hauptbahnhof"],
  ["Bf", "Bahnhof"],
  ["Hst", "Haltestelle"],
  ["Hp", "Haltepunkt"],
  ["ZOB", "Zentraler Omnibusbahnhof"],
  // English
  ["Stn", "Station"],
  ["Jct", "Junction"],
  ["Intl", "International"],
  // Dutch
  ["Cs", "Centraal"],
];

/**
 * Prefix-based synonym pairs (no trailing word boundary).
 * Handles cases like "St-Lazare" ↔ "Saint-Lazare".
 */
const PREFIX_PAIRS: [string, string][] = [
  // French
  ["St-", "Saint-"],
];

/**
 * Returns all query variants by substituting known synonym pairs.
 * The original query is always first.
 *
 *   "Aachen Hbf"          → ["Aachen Hbf", "Aachen Hauptbahnhof"]
 *   "Köln Hauptbahnhof"   → ["Köln Hauptbahnhof", "Köln Hbf"]
 *   "London St-Pancras"   → ["London St-Pancras", "London Saint-Pancras"]
 */
export function getQueryVariants(query: string): string[] {
  const variants = new Set<string>([query]);

  for (const [short, long] of SYNONYM_PAIRS) {
    const shortRe = new RegExp(`\\b${escapeRegex(short)}\\b`, "gi");
    const longRe = new RegExp(`\\b${escapeRegex(long)}\\b`, "gi");

    const expanded = query.replace(shortRe, long);
    if (expanded !== query) variants.add(expanded);

    const contracted = query.replace(longRe, short);
    if (contracted !== query) variants.add(contracted);
  }

  for (const [short, long] of PREFIX_PAIRS) {
    const shortRe = new RegExp(`\\b${escapeRegex(short)}`, "gi");
    const longRe = new RegExp(`\\b${escapeRegex(long)}`, "gi");

    const expanded = query.replace(shortRe, long);
    if (expanded !== query) variants.add(expanded);

    const contracted = query.replace(longRe, short);
    if (contracted !== query) variants.add(contracted);
  }

  return Array.from(variants);
}

/**
 * Canonical form: always expand abbreviations to their full forms.
 * Used for cache keys so "Hbf" and "Hauptbahnhof" queries share one slot.
 */
export function expandSearchQuery(query: string): string {
  let result = query;
  for (const [short, long] of SYNONYM_PAIRS) {
    result = result.replace(new RegExp(`\\b${escapeRegex(short)}\\b`, "gi"), long);
  }
  for (const [short, long] of PREFIX_PAIRS) {
    result = result.replace(new RegExp(`\\b${escapeRegex(short)}`, "gi"), long);
  }
  return result;
}

/**
 * Fetch results for all query variants and deduplicate by id.
 * If the query has no synonym matches, makes a single fetch call.
 */
export async function fetchWithVariants<T extends { id: string }>(
  query: string,
  fetcher: (q: string) => Promise<T[]>,
): Promise<T[]> {
  const variants = getQueryVariants(query);
  if (variants.length === 1) {
    return fetcher(variants[0]);
  }
  const results = await Promise.all(variants.map((v) => fetcher(v)));
  const seen = new Set<string>();
  return results.flat().filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
