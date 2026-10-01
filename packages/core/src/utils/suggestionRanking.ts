import type { BrandSuggestResponse } from "../types/brand";
import type { CategoryDefinition } from "../types/category";
import type { AutocompleteResult } from "../types/geocoding";
import type { ChipTranslation, PresetMatch } from "../types/presetMatch";
import {
  compareSearchSuggestions,
  MIN_SUGGESTION_TEXT_SCORE,
  mergeAutocompleteSuggestions,
  normalizeSearchTerm,
  type SuggestionScoreContext,
  textMatchScore,
} from "./searchSuggestion";

/** Rows the search box may show, gathered from every source before ranking. */
export interface AutocompleteCandidates {
  /** Home, Work and other labelled places; always listed first. */
  saved?: readonly AutocompleteResult[];
  recents?: readonly AutocompleteResult[];
  /** Built-in and integration categories. */
  categories?: readonly AutocompleteResult[];
  /** Tagging-schema presets; also category rows, sharing the category quota. */
  presets?: readonly AutocompleteResult[];
  brands?: readonly AutocompleteResult[];
  /** Geocoder and aggregate place suggestions, possibly overlapping. */
  places?: readonly AutocompleteResult[];
}

export interface AutocompleteRowLimits {
  total: number;
  categories: number;
  brands: number;
  recents: number;
}

/**
 * A handful of shortcuts, then places. Without a cap a single letter matched
 * dozens of categories, and eight foreign chains could push every place out
 * of view.
 */
export const DEFAULT_AUTOCOMPLETE_ROW_LIMITS: AutocompleteRowLimits = {
  total: 10,
  categories: 2,
  brands: 2,
  recents: 2,
};

type QuotaKey = Exclude<keyof AutocompleteRowLimits, "total">;

function quotaOf(row: AutocompleteResult): QuotaKey | undefined {
  if (row.type === "category") return "categories";
  if (row.type === "brand") return "brands";
  if (row.type === "recent_search") return "recents";
  return undefined;
}

/**
 * One ordered list for the search box. Every row is scored the same way (text
 * match scaled by locality, see `suggestionScore`), so a nearby café can rank
 * above a chain and a far city above a nearby partial match. Saved places stay
 * first; category, chain and recent-search rows are capped by `limits`.
 */
export function rankAutocompleteRows(
  candidates: AutocompleteCandidates,
  context: SuggestionScoreContext,
  limits: AutocompleteRowLimits = DEFAULT_AUTOCOMPLETE_ROW_LIMITS,
): AutocompleteResult[] {
  const categories = candidates.categories ?? [];
  const categoryLabels = new Set(categories.map((row) => normalizeSearchTerm(row.label)));
  // A preset repeating a built-in category's name would open the same search.
  const presets = (candidates.presets ?? []).filter(
    (row) => !categoryLabels.has(normalizeSearchTerm(row.label)),
  );
  const shortcuts = [
    ...categories,
    ...presets,
    ...(candidates.brands ?? []),
    ...(candidates.recents ?? []),
  ].filter((row) => textMatchScore(row, context.query) >= MIN_SUGGESTION_TEXT_SCORE);
  const places = mergeAutocompleteSuggestions(candidates.places ?? [], context);
  const ordered = [...shortcuts, ...places].sort((a, b) => compareSearchSuggestions(a, b, context));

  const rows = [...(candidates.saved ?? [])];
  const used: Record<QuotaKey, number> = { categories: 0, brands: 0, recents: 0 };
  for (const row of ordered) {
    if (rows.length >= limits.total) break;
    const quota = quotaOf(row);
    if (quota) {
      if (used[quota] >= limits[quota]) continue;
      used[quota] += 1;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Whether plain Enter may act on `row` without the user picking it: the typed
 * text must name it outright or start its name, not merely appear somewhere
 * in its address.
 */
export function isConfidentTopRow(row: AutocompleteResult, query: string): boolean {
  if (row.type === "text_search" || row.type === "nlp_search") return false;
  return textMatchScore(row, query) >= 0.8;
}

/** Floor for a category name or term to count as meant: every word typed starts one of its words. */
const CATEGORY_MATCH_FLOOR = 0.7;

function bestCategoryMatch(
  names: readonly (string | undefined)[],
  query: string,
): { value: string; score: number } | undefined {
  let best: { value: string; score: number } | undefined;
  for (const value of names) {
    if (!value) continue;
    const score = textMatchScore({ id: "", label: value, type: "category" }, query);
    if (score >= CATEGORY_MATCH_FLOOR && (!best || score > best.score)) best = { value, score };
  }
  return best;
}

export interface IntegrationSearchCategory {
  id: string;
  label: string;
  iconPath?: string;
}

export interface CategoryMatchInput {
  query: string;
  categories: readonly CategoryDefinition[];
  /** Categories that integrations register for search (parking, charging…). */
  integrationCategories?: readonly IntegrationSearchCategory[];
  chipTranslations?: Readonly<Record<string, ChipTranslation>>;
  /** Secondary line shown under every category row. */
  sublabel: string;
}

/**
 * Category rows whose English label, localized name, or a localized search
 * term starts with what was typed ("coffee" → Cafes via the term "coffee").
 * The matched name travels as `searchMatch`, so ranking scores the row on the
 * word the user meant rather than on the display label.
 */
export function matchCategorySuggestions({
  query,
  categories,
  integrationCategories = [],
  chipTranslations = {},
  sublabel,
}: CategoryMatchInput): AutocompleteResult[] {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery) return [];

  const rows: AutocompleteResult[] = [];
  const seen = new Set<string>();
  const push = (
    id: string,
    label: string,
    iconPath: string | undefined,
    match: { value: string; score: number } | undefined,
  ) => {
    const rowId = `category-${id}`;
    if (!match || seen.has(rowId)) return;
    seen.add(rowId);
    rows.push({
      id: rowId,
      label,
      sublabel,
      type: "category",
      iconPath,
      // Category names and search terms are curated aliases of the
      // category, so typing one out in full is as explicit as a place alias.
      searchMatch: {
        kind: "explicit_alias",
        value: match.value,
        normalized: normalizeSearchTerm(match.value),
      },
    });
  };

  // An integration can own the same category ID as the built-in POI list
  // (parking does); selection already routes that ID to the integration.
  // Localized names and terms are keyed by category ID, so they apply to
  // integration categories too ("Tankstelle" finds fuel).
  for (const category of integrationCategories) {
    // Integration ids are kebab-case ("ev-charging"); chip ids are snake_case.
    const translation =
      chipTranslations[category.id] ?? chipTranslations[category.id.replaceAll("-", "_")];
    push(
      category.id,
      translation?.name || category.label,
      category.iconPath,
      bestCategoryMatch([category.label, translation?.name, ...(translation?.terms ?? [])], query),
    );
  }
  for (const category of categories) {
    const translation = chipTranslations[category.id];
    push(
      category.id,
      translation?.name || category.label,
      category.iconPath,
      bestCategoryMatch([category.label, translation?.name, ...(translation?.terms ?? [])], query),
    );
  }
  return rows;
}

/** Chain rows from a brand-suggest response; `fallbackSublabel` stands in for a missing description. */
export function brandSuggestionRows(
  matches: BrandSuggestResponse["matches"],
  fallbackSublabel: string,
): AutocompleteResult[] {
  return matches.map((brand) => ({
    id: `brand:${brand.qid}`,
    label: brand.name,
    sublabel: brand.description ?? fallbackSublabel,
    type: "brand",
    brand,
    brandPresence: brand.presence,
  }));
}

/** Category rows for tagging-schema presets from a preset-suggest response. */
export function presetSuggestionRows(
  matches: readonly PresetMatch[],
  sublabel: string,
): AutocompleteResult[] {
  return matches.map((preset) => ({
    id: `category-preset:${preset.id}`,
    label: preset.name,
    sublabel,
    type: "category",
    presetIconKey: preset.iconKey,
  }));
}

/**
 * Past searches that the typed text starts a word of, most recent first. The
 * query itself is left out: repeating it offers nothing new.
 */
export function matchRecentSearches(
  recents: readonly string[],
  query: string,
): AutocompleteResult[] {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery) return [];
  return recents
    .filter((recent) => {
      const normalized = normalizeSearchTerm(recent);
      return (
        normalized !== normalizedQuery &&
        textMatchScore({ id: "", label: recent, type: "recent_search" }, query) >=
          CATEGORY_MATCH_FLOOR
      );
    })
    .map((recent) => ({
      id: `recent:${normalizeSearchTerm(recent)}`,
      label: recent,
      type: "recent_search" as const,
    }));
}
