import type { BrandSuggestResponse } from "../types/brand";
import type { CategoryDefinition } from "../types/category";
import type { AutocompleteResult } from "../types/geocoding";
import type { ChipTranslation, PresetMatch } from "../types/presetMatch";
import {
  CONFIDENT_TEXT_SCORE,
  compareSearchSuggestions,
  destinationPlausibility,
  isPlaceRow,
  isSameDestination,
  MIN_SUGGESTION_TEXT_SCORE,
  mergeAutocompleteSuggestions,
  normalizeSearchTerm,
  prominence,
  queryNamesLocation,
  type RankedSuggestion,
  type SuggestionScoreContext,
  suggestionScore,
  textMatchScore,
  tripReach,
  WORD_MATCH_TEXT_SCORE,
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

/** Each row's position among the rows its provider returned, in the order given. */
function withProviderRanks(rows: readonly AutocompleteResult[]): RankedSuggestion[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (!row.provider) return row;
    const providerRank = seen.get(row.provider) ?? 0;
    seen.set(row.provider, providerRank + 1);
    return { ...row, providerRank };
  });
}

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
  // A preset repeating a built-in category's name, or its singular ("Museum"
  // beside "Museums"), offers the same search twice.
  const presets = (candidates.presets ?? []).filter((row) => {
    const label = normalizeSearchTerm(row.label);
    return !categoryLabels.has(label) && !categoryLabels.has(`${label}s`);
  });
  const shortcuts = [
    ...categories,
    ...presets,
    ...(candidates.brands ?? []),
    ...(candidates.recents ?? []),
  ].filter((row) => textMatchScore(row, context.query) >= MIN_SUGGESTION_TEXT_SCORE);
  const places = mergeAutocompleteSuggestions(withProviderRanks(candidates.places ?? []), context);
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
 * What plain Enter does with the rows shown:
 * - `open` the row, which the text names outright;
 * - `search` the visible area for the text, because it names a kind of place
 *   there (several shops, a word that starts many names) or nothing in
 *   particular (`weak`: no row is named, so a geocoder may still try);
 * - let the user `choose`, because several places far away answer equally.
 */
export type EnterAction =
  | { kind: "open"; row: AutocompleteResult }
  | { kind: "search"; weak: boolean }
  | { kind: "choose" };

/**
 * Below this a place is an obscure namesake far from the map, not a
 * destination: "vegan" from Aachen is not the hamlet of Vegan in Norway.
 * A town anywhere (0.6), a large airport (0.72) or anything within a trip of
 * the map clears it; a hamlet abroad (0.2) does not.
 */
const MIN_DESTINATION_PLAUSIBILITY = 0.3;
/**
 * Two places answering the text equally well are a toss-up unless one leads by
 * this much: about the lead of a place on the map over one a district away.
 */
const RIVAL_SCORE_MARGIN = 0.35;
/** A place this far within a trip of the map is in the area being searched. */
const IN_AREA_REACH = 0.5;
/**
 * A place this much more famous than a namesake is the one meant: Big Ben in
 * London (fame 0.8) over the volcano on Heard Island (0.5), a museum over a
 * bar, but not one city over another of its rank.
 */
const RIVAL_FAME_GAP = 0.25;

/** Areas, addresses and everything else are not alternatives to each other. */
function placeKind(row: AutocompleteResult): "area" | "address" | "place" {
  if (row.type === "region") return "area";
  if (row.type === "address" || row.type === "street") return "address";
  return "place";
}

/**
 * Whether `place` may be opened for the text without being picked, as far as
 * where it is goes: the text says where (a house number, "… berlin"), or the
 * place is famous enough or close enough to be the one meant.
 */
export function isPlausibleDestination(
  place: AutocompleteResult,
  context: SuggestionScoreContext,
): boolean {
  return (
    queryNamesLocation(place, context.query) ||
    destinationPlausibility(place, context) >= MIN_DESTINATION_PLAUSIBILITY
  );
}

/**
 * Decides what Enter does with `rows` (ranked, without the area-search row).
 * Enter opens a place only when it is plainly the one meant: named by the
 * text, plausibly a destination, and not one of several equal answers. A
 * chain's branches or a word many names start with ("aldi", "döner", "vegan")
 * search the area; a chain row the text names exactly opens that chain.
 */
export function enterAction(
  rows: readonly AutocompleteResult[],
  context: SuggestionScoreContext,
): EnterAction {
  const top = rows[0];
  if (!top || top.type === "text_search" || top.type === "nlp_search") {
    return { kind: "search", weak: true };
  }
  const text = (row: AutocompleteResult) => textMatchScore(row, context.query);
  const topText = text(top);
  if (topText < CONFIDENT_TEXT_SCORE) return { kind: "search", weak: true };
  if (!isPlaceRow(top)) return { kind: "open", row: top };

  const places = rows.filter(isPlaceRow);
  // Whether the area has places the text matches; a search of it then finds something.
  const inArea = places.some(
    (row) => text(row) >= WORD_MATCH_TEXT_SCORE && tripReach(row, context) >= IN_AREA_REACH,
  );
  // Only a chain with shops in the map's country: "springfield" from Berlin is
  // not the Spanish fashion chain.
  const exactChain = rows.find(
    (row) => row.type === "brand" && row.brandPresence === "here" && text(row) >= 1,
  );
  const undecided = (): EnterAction =>
    exactChain
      ? { kind: "open", row: exactChain }
      : inArea
        ? { kind: "search", weak: false }
        : { kind: "choose" };

  if (!isPlausibleDestination(top, context)) return undecided();

  // A rival is another destination of the same kind, named as well and nearly
  // as likely: a city is not rivalled by its own airport, a station near the
  // map not by an unknown park of the same name 200 km away, and the Louvre
  // not by a bar called Louvre.
  const topScore = suggestionScore(top, context);
  const topFame = prominence(top);
  const rivalled = places.some(
    (row) =>
      row !== top &&
      placeKind(row) === placeKind(top) &&
      text(row) >= topText &&
      !isSameDestination(row, top) &&
      isPlausibleDestination(row, context) &&
      topFame - prominence(row) < RIVAL_FAME_GAP &&
      topScore - suggestionScore(row, context) < RIVAL_SCORE_MARGIN,
  );
  return rivalled ? undecided() : { kind: "open", row: top };
}

/** Floor for a category name or term to count as meant: every word typed starts one of its words. */
const CATEGORY_MATCH_FLOOR = 0.7;

/**
 * Least share of a search term the query must cover to match it by its start.
 * A term is a synonym, not the category's name: "coff" means coffee, but
 * "bio" means organic, not the fuel category's "biodiesel".
 */
const MIN_TERM_PREFIX_SHARE = 0.5;

function bestCategoryMatch(
  names: readonly (string | undefined)[],
  terms: readonly string[],
  query: string,
): { value: string; score: number } | undefined {
  let best: { value: string; score: number } | undefined;
  const queryLength = normalizeSearchTerm(query).length;
  const consider = (value: string, isTerm: boolean) => {
    if (isTerm && queryLength < normalizeSearchTerm(value).length * MIN_TERM_PREFIX_SHARE) return;
    const score = textMatchScore({ id: "", label: value, type: "category" }, query);
    if (score >= CATEGORY_MATCH_FLOOR && (!best || score > best.score)) best = { value, score };
  };
  for (const value of names) if (value) consider(value, false);
  for (const value of terms) consider(value, true);
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
      bestCategoryMatch([category.label, translation?.name], translation?.terms ?? [], query),
    );
  }
  for (const category of categories) {
    const translation = chipTranslations[category.id];
    push(
      category.id,
      translation?.name || category.label,
      category.iconPath,
      bestCategoryMatch([category.label, translation?.name], translation?.terms ?? [], query),
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
