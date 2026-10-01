import { isTransitRawCategory } from "../hooks/transit/transitEligibility";
import type { AutocompleteResult } from "../types/geocoding";
import type { LngLat } from "../types/geometry";
import type { Ids } from "../types/identified";
import type { SearchMatchKind } from "../types/searchSuggestion";
import { haversineDistance } from "./coordinates";

const AIRPORT_RAW_CATEGORY = "aeroway/aerodrome";

const UNKNOWN_PROXIMITY_METERS = Number.MAX_SAFE_INTEGER;
/**
 * Two same-named suggestions closer than this are treated as one place. Wide
 * enough that a station record from a rail operator, the OSM station node and
 * a timetable stop (which can sit several hundred metres apart on a large
 * station) collapse; the label check keeps distinct neighbours apart.
 */
const SAME_PLACE_MAX_METERS = 1_000;

/**
 * How well the typed text matches, before location is considered. Provider
 * evidence of an official code or alias typed out in full ranks above any
 * name; within names, the whole name beats its start, which beats a later
 * word, which beats a word of the address.
 */
const TEXT_SCORE = {
  exactCode: 1.4,
  exactExplicit: 1.3,
  exact: 1,
  prefix: 0.8,
  wordPrefix: 0.7,
  acronym: 0.7,
  contextWordPrefix: 0.5,
  contains: 0.3,
  other: 0.15,
} as const;

/**
 * Text-only floor for rows the client adds itself (categories, chains, recent
 * searches): they must share a word start or at least a substring with the
 * query. Geocoder rows are kept below it — the provider may have matched a
 * typo the text check cannot see.
 */
export const MIN_SUGGESTION_TEXT_SCORE = TEXT_SCORE.contains;

/**
 * Weights of the three parts of a row's score: text match + DISTANCE × nearby
 * credit + PROMINENCE × prominence. They add rather than multiply so that
 * fame still counts when everything is near (at country zoom, Frankfurt am
 * Main must beat a village called Frankfurt) and nearness still counts when a
 * name is only partly typed. The gap between an exact name and its start
 * (0.2) is smaller than a city's prominence share (0.8 × 0.9), so "paris"
 * from Berlin keeps Paris ahead of Paris Bar next door; and it is larger than
 * a county's (0.8 × 0.2), so "coffee" keeps nearby cafés ahead of a far
 * Coffee County.
 */
const DISTANCE_WEIGHT = 0.8;
const PROMINENCE_WEIGHT = 0.8;
const DEFAULT_ZOOM = 12;
/** Distance at which a place keeps half its nearby credit, at zoom 14. */
const HALF_CREDIT_KM_AT_Z14 = 5;
const MIN_HALF_CREDIT_KM = 1;
const MAX_HALF_CREDIT_KM = 5_000;
/** Non-area places are destinations for their prominence far less often than areas. */
const PLACE_PROMINENCE_SHARE = 0.35;
const AIRPORT_PROMINENCE_SHARE = 0.8;
const DEFAULT_AREA_PROMINENCE = 0.3;
/**
 * An official code or alias typed out in full names one place outright, as a
 * destination from anywhere: its prominence starts here, and the place's own
 * prominence fills the rest.
 */
const EXPLICIT_MATCH_PROMINENCE = 0.8;
/**
 * Nearby credit of rows without a position. A category is a search of the
 * area itself, as near as anything can be, so the word for a kind of place
 * ("coffee", "apotheke") leads even past places named exactly that.
 */
const CATEGORY_LOCALITY = 1;
const RECENT_LOCALITY = 0.6;

/**
 * Prominence of an area by its settlement or admin rank, keyed on the value
 * half of a provider's `class/value` raw category (OSM `place=*` for Photon
 * and Nominatim, MapTiler's place types and settlement designations).
 */
const AREA_PROMINENCE: Record<string, number> = {
  country: 1,
  city: 0.9,
  state: 0.8,
  region: 0.8,
  province: 0.8,
  municipality: 0.7,
  town: 0.6,
  subregion: 0.4,
  borough: 0.4,
  suburb: 0.4,
  village: 0.4,
  municipal_district: 0.3,
  district: 0.3,
  county: 0.2,
  hamlet: 0.2,
  quarter: 0.2,
  neighbourhood: 0.2,
  locality: 0.2,
  isolated_dwelling: 0.1,
};

const BRAND_PRESENCE_LOCALITY: Record<NonNullable<AutocompleteResult["brandPresence"]>, number> = {
  here: 0.5,
  global: 0.5,
  unknown: 0.3,
  elsewhere: 0.1,
};

/** Apostrophes join a word ("King's") rather than split it, so they are dropped before matching. */
const APOSTROPHES = /['’ʼ`]/gu;

export interface SuggestionScoreContext {
  query: string;
  proximity?: LngLat;
  /** Map zoom; decides how quickly nearby credit fades with distance. */
  zoom?: number;
}

export function normalizeSearchTerm(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isUppercaseAcronymIntent(raw: string): boolean {
  const compact = raw.trim();
  const characters = Array.from(compact);
  return (
    characters.length >= 2 &&
    characters.length <= 8 &&
    /\p{Lu}/u.test(compact) &&
    /^[\p{Lu}\p{N}]+$/u.test(compact)
  );
}

/**
 * The form names are compared in on the client: search normalization with
 * apostrophes dropped, so "kings cross" matches "King's Cross". Kept apart from
 * `normalizeSearchTerm`, which also keys stored search indexes.
 */
export function matchKey(raw: string): string {
  return normalizeSearchTerm(raw.replace(APOSTROPHES, ""));
}

function words(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

function everyTokenStartsAWord(tokens: string[], candidates: string[]): boolean {
  return tokens.every((token) => candidates.some((word) => word.startsWith(token)));
}

function exactMatchScore(kind: SearchMatchKind): number {
  if (kind === "authoritative_code") return TEXT_SCORE.exactCode;
  if (kind === "explicit_alias" || kind === "explicit_reference") return TEXT_SCORE.exactExplicit;
  if (kind === "generated_acronym") return TEXT_SCORE.acronym;
  return TEXT_SCORE.exact;
}

/**
 * How well `item` matches the typed `query`, from 0.15 (the provider returned
 * it but no query word appears in it) up to 1.4 (an exact official code).
 * Provider match evidence counts first, compared the way the provider
 * normalized it; the label, then label plus sublabel, are the fallbacks.
 */
export function textMatchScore(item: AutocompleteResult, query: string): number {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery) return 0;
  const match = item.searchMatch;
  if (match?.normalized === normalizedQuery) return exactMatchScore(match.kind);
  if (match?.normalized.startsWith(normalizedQuery) && match.kind !== "generated_acronym") {
    return TEXT_SCORE.prefix;
  }

  const key = matchKey(query);
  const label = matchKey(item.label);
  if (label === key) return TEXT_SCORE.exact;
  if (label.startsWith(key)) return TEXT_SCORE.prefix;
  const tokens = words(key);
  if (everyTokenStartsAWord(tokens, words(label))) return TEXT_SCORE.wordPrefix;
  const context = matchKey(`${item.label} ${item.sublabel ?? ""}`);
  if (everyTokenStartsAWord(tokens, words(context))) return TEXT_SCORE.contextWordPrefix;
  if (tokens.every((token) => context.includes(token))) return TEXT_SCORE.contains;
  return TEXT_SCORE.other;
}

function proximityDistance(item: AutocompleteResult, proximity?: LngLat): number {
  if (!proximity || !item.coordinates) return UNKNOWN_PROXIMITY_METERS;
  return haversineDistance(item.coordinates, proximity);
}

/**
 * 1 at the reference point, ½ at the half-credit distance. That distance
 * doubles with each zoom level out, so "near" means a few streets on a city
 * map and a few hundred kilometres on a continent.
 */
function distanceFactor(item: AutocompleteResult, proximity?: LngLat, zoom?: number): number {
  const metres = proximityDistance(item, proximity);
  if (metres === UNKNOWN_PROXIMITY_METERS) return 0;
  const halfCreditKm = Math.min(
    MAX_HALF_CREDIT_KM,
    Math.max(MIN_HALF_CREDIT_KM, HALF_CREDIT_KM_AT_Z14 * 2 ** (14 - (zoom ?? DEFAULT_ZOOM))),
  );
  return 1 / (1 + metres / 1000 / halfCreditKm);
}

function rawCategoryValue(rawCategory?: string): string | undefined {
  if (!rawCategory) return undefined;
  const slash = rawCategory.lastIndexOf("/");
  return slash === -1 ? rawCategory : rawCategory.slice(slash + 1);
}

/**
 * How much of a destination a place is on its own, 0–1, wherever the map is:
 * areas by settlement or admin rank, airports by size, other places by a
 * provider's importance, discounted.
 */
function prominence(item: AutocompleteResult): number {
  if (item.type === "region") {
    const byRank = AREA_PROMINENCE[rawCategoryValue(item.rawCategory) ?? ""];
    return item.importance ?? byRank ?? DEFAULT_AREA_PROMINENCE;
  }
  const importance = item.importance ?? 0;
  if (item.rawCategory === AIRPORT_RAW_CATEGORY) return importance * AIRPORT_PROMINENCE_SHARE;
  return importance * PLACE_PROMINENCE_SHARE;
}

function isPlaceRow(item: AutocompleteResult): boolean {
  return (
    item.type === "address" ||
    item.type === "poi" ||
    item.type === "street" ||
    item.type === "region" ||
    item.type === "transit_stop"
  );
}

/**
 * How much the row belongs to the area being searched, 0–1. A place earns it
 * by being close (fading faster the further the map is zoomed in); categories
 * and recent searches always apply to the area; chains depend on whether they
 * operate in the map's country.
 */
export function localityScore(item: AutocompleteResult, context: SuggestionScoreContext): number {
  switch (item.type) {
    case "category":
      return CATEGORY_LOCALITY;
    case "recent_search":
      return RECENT_LOCALITY;
    case "brand":
      return BRAND_PRESENCE_LOCALITY[item.brandPresence ?? "unknown"];
    case "labeled_place":
    case "nlp_search":
    case "text_search":
      return 1;
    default:
      return distanceFactor(item, context.proximity, context.zoom);
  }
}

/** One comparable score for any dropdown row: text match, plus nearness, plus fame. */
export function suggestionScore(item: AutocompleteResult, context: SuggestionScoreContext): number {
  const text = textMatchScore(item, context.query);
  if (!isPlaceRow(item)) return text + DISTANCE_WEIGHT * localityScore(item, context);
  const ownProminence = prominence(item);
  const fame =
    text >= TEXT_SCORE.exactExplicit
      ? EXPLICIT_MATCH_PROMINENCE + (1 - EXPLICIT_MATCH_PROMINENCE) * ownProminence
      : ownProminence;
  return text + DISTANCE_WEIGHT * localityScore(item, context) + PROMINENCE_WEIGHT * fame;
}

export function compareSearchSuggestions(
  a: AutocompleteResult,
  b: AutocompleteResult,
  context: SuggestionScoreContext,
): number {
  const scoreDifference = suggestionScore(b, context) - suggestionScore(a, context);
  if (scoreDifference !== 0) return scoreDifference;

  const proximityDifference =
    proximityDistance(a, context.proximity) - proximityDistance(b, context.proximity);
  if (proximityDifference !== 0) return proximityDifference;

  return a.id.localeCompare(b.id);
}

function hasSharedIdentity(a?: Ids, b?: Ids): boolean {
  if (!a || !b) return false;
  return Object.entries(a).some(([namespace, value]) => value !== "" && b[namespace] === value);
}

/**
 * Whether a row is a station or stop, something else, or unknown (a provider
 * that reports no category). Airports count as something else: they are
 * conflated with the catalog's airport records by name and position.
 */
function transitKind(item: AutocompleteResult): "transit" | "other" | "unknown" {
  if (item.type === "transit_stop") return "transit";
  if (item.rawCategory) {
    return item.rawCategory !== AIRPORT_RAW_CATEGORY && isTransitRawCategory(item.rawCategory)
      ? "transit"
      : "other";
  }
  return item.type === "poi" ? "unknown" : "other";
}

function hasSameCanonicalLocation(a: AutocompleteResult, b: AutocompleteResult): boolean {
  if (!a.coordinates || !b.coordinates) return false;
  if (normalizeSearchTerm(a.label) !== normalizeSearchTerm(b.label)) return false;
  // A station named after the square it serves is a different destination
  // from the square; merging them hid the station for "alexanderplatz".
  const kinds = new Set([transitKind(a), transitKind(b)]);
  if (kinds.has("transit") && kinds.has("other")) return false;
  return haversineDistance(a.coordinates, b.coordinates) < SAME_PLACE_MAX_METERS;
}

function sameSuggestion(a: AutocompleteResult, b: AutocompleteResult): boolean {
  return a.id === b.id || hasSharedIdentity(a.ids, b.ids) || hasSameCanonicalLocation(a, b);
}

function providerIds(item: AutocompleteResult): string[] {
  const providers = item.contributingProviders ? [...item.contributingProviders] : [];
  if (item.provider && !providers.includes(item.provider)) providers.push(item.provider);
  return providers;
}

function mergeDuplicate(
  stronger: AutocompleteResult,
  weaker: AutocompleteResult,
): AutocompleteResult {
  const contributingProviders = [...providerIds(stronger)];
  for (const provider of providerIds(weaker)) {
    if (!contributingProviders.includes(provider)) contributingProviders.push(provider);
  }
  return {
    ...stronger,
    ids:
      stronger.ids || weaker.ids ? { ...(weaker.ids ?? {}), ...(stronger.ids ?? {}) } : undefined,
    contributingProviders: contributingProviders.length > 0 ? contributingProviders : undefined,
  };
}

export function mergeAutocompleteSuggestions(
  items: readonly AutocompleteResult[],
  context: SuggestionScoreContext,
): AutocompleteResult[] {
  const sorted = [...items].sort((a, b) => compareSearchSuggestions(a, b, context));
  const merged: AutocompleteResult[] = [];

  for (const item of sorted) {
    const normalizedItem = {
      ...item,
      contributingProviders: providerIds(item).length > 0 ? providerIds(item) : undefined,
    };
    const duplicateIndex = merged.findIndex((candidate) => sameSuggestion(candidate, item));
    if (duplicateIndex === -1) merged.push(normalizedItem);
    else merged[duplicateIndex] = mergeDuplicate(merged[duplicateIndex], normalizedItem);
  }

  return merged;
}
