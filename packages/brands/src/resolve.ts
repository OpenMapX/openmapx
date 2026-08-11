import { BRAND_QID_KEYS } from "@openmapx/core";
import type { BrandIndex } from "./loader";
import type { BrandEntry } from "./types";

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
