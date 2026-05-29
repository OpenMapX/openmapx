import type { CategoryPlace } from "@integrations/poi-search/types";
import {
  FOOD_FILTER_CATEGORY_IDS,
  HOURS_FILTER_CATEGORY_IDS,
} from "@integrations/poi-search/types";
import { CATEGORY_FILTERS } from "./overpass.service";

export type FacetType = "toggle" | "multi";
export type FacetPlacement = "inline" | "panel";

export interface CategoryFacet {
  /** Stable id; also the i18n key under the `category` namespace. */
  id: string;
  type: FacetType;
  /** "inline" facets render as their own chip; "panel" facets live in the Filters popover. */
  placement: FacetPlacement;
  /** OSM tag (from the result's curated `osmTags`) this facet reads. */
  tag: string;
  /** Category ids this facet is offered for. */
  categoryIds: ReadonlySet<string>;
  /** For `toggle` facets: OSM tag values that count as a match. */
  matchValues?: readonly string[];
  /** Optional grouping for panel layout (e.g. "dietary" renders under a subheading). */
  group?: string;
}

/**
 * Facet filter registry. The OSM tags here must also be present in the
 * Overpass provider's `FILTERABLE_TAG_KEYS` allowlist so the values reach the
 * client. Adding a facet is: allowlist the tag, add an entry here, add an
 * i18n label, and (panel facets) it shows up in the Filters popover.
 */
export const CATEGORY_FACETS: readonly CategoryFacet[] = [
  {
    id: "wheelchairAccessible",
    type: "toggle",
    placement: "inline",
    tag: "wheelchair",
    categoryIds: HOURS_FILTER_CATEGORY_IDS,
    matchValues: ["yes", "designated", "limited"],
  },
  {
    id: "outdoorSeating",
    type: "toggle",
    placement: "panel",
    tag: "outdoor_seating",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes"],
  },
  {
    id: "takeaway",
    type: "toggle",
    placement: "panel",
    tag: "takeaway",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes", "only"],
  },
  {
    id: "delivery",
    type: "toggle",
    placement: "panel",
    tag: "delivery",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes"],
  },
  {
    id: "wifi",
    type: "toggle",
    placement: "panel",
    tag: "internet_access",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["wlan", "yes", "wired", "terminal"],
  },
  {
    id: "vegetarian",
    type: "toggle",
    placement: "panel",
    tag: "diet:vegetarian",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes", "only"],
    group: "dietary",
  },
  {
    id: "vegan",
    type: "toggle",
    placement: "panel",
    tag: "diet:vegan",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes", "only"],
    group: "dietary",
  },
  {
    id: "halal",
    type: "toggle",
    placement: "panel",
    tag: "diet:halal",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes", "only"],
    group: "dietary",
  },
  {
    id: "kosher",
    type: "toggle",
    placement: "panel",
    tag: "diet:kosher",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes", "only"],
    group: "dietary",
  },
  {
    id: "glutenFree",
    type: "toggle",
    placement: "panel",
    tag: "diet:gluten_free",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
    matchValues: ["yes", "only"],
    group: "dietary",
  },
  {
    id: "cuisine",
    type: "multi",
    placement: "panel",
    tag: "cuisine",
    categoryIds: FOOD_FILTER_CATEGORY_IDS,
  },
];

/** Facets offered for a given category, in registry order. */
export function facetsForCategory(categoryId: string | null | undefined): CategoryFacet[] {
  if (!categoryId) return [];
  return CATEGORY_FACETS.filter((f) => f.categoryIds.has(categoryId));
}

/** True when the facet's selection is active. */
function isActive(selection: string[] | undefined): boolean {
  return (selection?.length ?? 0) > 0;
}

function tagValues(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Filters results against the active facet selections. A `toggle` facet keeps
 * places whose tag matches one of its `matchValues`; a `multi` facet keeps
 * places whose (`;`-separated) tag values intersect the selected values. Multiple
 * active facets are ANDed together.
 */
export function applyFacetFilters(
  results: CategoryPlace[],
  selections: Record<string, string[]>,
): CategoryPlace[] {
  const active = CATEGORY_FACETS.filter((f) => isActive(selections[f.id]));
  if (active.length === 0) return results;
  return results.filter((p) =>
    active.every((f) => {
      const raw = p.osmTags?.[f.tag];
      if (f.type === "toggle") return !!raw && (f.matchValues ?? []).includes(raw);
      const selected = selections[f.id];
      return tagValues(raw).some((v) => selected.includes(v));
    }),
  );
}

/** Distinct, sorted cuisine values present in the result set (for the multi-select). */
export function cuisineOptions(results: readonly CategoryPlace[]): string[] {
  const set = new Set<string>();
  for (const p of results) {
    for (const v of tagValues(p.osmTags?.cuisine)) set.add(v);
  }
  return [...set].sort();
}

// Reverse lookup: OSM tag value (e.g. "fast_food") → the first category id whose
// CATEGORY_FILTERS list claims it. Lets a free-text search reuse a category's
// facet config. Built once at module load.
const VALUE_TO_CATEGORY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [categoryId, filters] of Object.entries(CATEGORY_FILTERS)) {
    for (const f of filters) {
      if (!(f.value in map)) map[f.value] = categoryId;
    }
  }
  return map;
})();

/**
 * Infer the dominant category of a result set by majority of OSM category
 * values, so a free-text search can reuse that category's facet filters (e.g.
 * "McDonald's" → mostly fast_food → "restaurants"). Returns null when no
 * results map to a known category.
 */
export function detectDominantCategory(results: readonly CategoryPlace[]): string | null {
  const counts = new Map<string, number>();
  for (const p of results) {
    const id = p.category ? VALUE_TO_CATEGORY[p.category] : undefined;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = id;
    }
  }
  return best;
}
