import { CATEGORY_FILTERS } from "../../utils/overpass.service";
import { canonicalTagSet } from "./matcher";
import type { PresetIndexEntry } from "./types";

export interface ChipTranslation {
  /** Localised display name (e.g. "Tankstelle"). Empty when no preset matches the chip's tag-set. */
  name: string;
  /** Localised search terms (already lower-cased + diacritic-stripped). */
  terms: string[];
}

/**
 * For each chip category in `CATEGORY_FILTERS`, find the iD preset whose tag-set
 * exactly matches the chip's filter union and emit its localised display name +
 * search terms. Multi-value chips (e.g. `restaurants` covers 5 amenity values)
 * have no exact preset and are omitted — the SearchBar matches those by their
 * English chip label only, which is the existing behaviour.
 *
 * Result is keyed by chip id (e.g. `pharmacies`, `fuel`). The shape is small
 * (≤53 entries × 2 short fields) so it's safe to ship to the browser per-locale.
 */
export function buildChipTranslations(
  langSlice: readonly PresetIndexEntry[],
): Record<string, ChipTranslation> {
  const byTagSet = new Map<string, PresetIndexEntry>();
  for (const entry of langSlice) {
    byTagSet.set(canonicalTagSet(entry.tags), entry);
  }

  const out: Record<string, ChipTranslation> = {};
  for (const [chipId, filters] of Object.entries(CATEGORY_FILTERS)) {
    const tagObj: Record<string, string> = {};
    let multiValue = false;
    for (const f of filters) {
      if (f.key in tagObj && tagObj[f.key] !== f.value) {
        multiValue = true;
        break;
      }
      tagObj[f.key] = f.value;
    }
    if (multiValue) continue;
    const entry = byTagSet.get(canonicalTagSet(tagObj));
    if (entry) {
      out[chipId] = { name: entry.displayName, terms: entry.normalizedTerms };
    }
  }
  return out;
}
