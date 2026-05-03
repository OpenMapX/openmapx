import { CATEGORY_FILTERS } from "../../utils/overpass.service";
import { canonicalTagSet } from "./matcher";

/**
 * Build the set of canonical tag-set strings used by the chip-bar `CATEGORY_FILTERS`.
 * Preset matches whose canonical tag-set is in this set are suppressed in /preset-suggest
 * results so the curated chip suggestion wins.
 *
 * Granularity is per-chip (not per-OSM-tag): only presets whose tag-set is *exactly*
 * the union of a chip's filters get suppressed. Single-tag presets remain visible
 * alongside multi-tag chip categories.
 */
export function buildChipOverlapSet(): Set<string> {
  const out = new Set<string>();
  for (const filters of Object.values(CATEGORY_FILTERS)) {
    const asObj: Record<string, string> = {};
    let multiValue = false;
    for (const f of filters) {
      if (f.key in asObj && asObj[f.key] !== f.value) {
        multiValue = true;
        break;
      }
      asObj[f.key] = f.value;
    }
    if (!multiValue && Object.keys(asObj).length === filters.length) {
      out.add(canonicalTagSet(asObj));
    }
  }
  return out;
}
