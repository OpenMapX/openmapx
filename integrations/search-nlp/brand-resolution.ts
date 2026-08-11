import { suggestBrands } from "@openmapx/brands";
import type { OverpassFilter } from "@openmapx/core";

/**
 * Upgrades a `brand=<name>` predicate to `brand:wikidata=<qid>`.
 *
 * Only an exact, unambiguous catalog hit substitutes. A fuzzy match across 26k
 * brands would confidently rewrite "Star" into the wrong chain, and a wrong QID
 * returns zero results rather than approximately-right ones — strictly worse
 * than leaving the name predicate the model produced.
 */
export function resolveBrandPredicates(
  filter: OverpassFilter,
  country: string | undefined,
): OverpassFilter {
  const require = filter.require;
  if (!require?.length) return filter;

  let changed = false;
  const next = require.map((pred) => {
    if (pred.key !== "brand" || pred.op !== "=" || !pred.value) return pred;
    const [top] = suggestBrands(pred.value, country, 1);
    if (top?.matchedOn !== "name") return pred;
    // Guard against a prefix hit: only an exact name match may substitute.
    if (top.name.toLowerCase() !== pred.value.toLowerCase()) return pred;
    changed = true;
    return { key: "brand:wikidata", op: "=" as const, value: top.qid };
  });

  return changed ? { ...filter, require: next } : filter;
}
