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
 * Sources put a city's point kilometres apart: Wikidata has Tokyo in
 * Shinjuku, OpenStreetMap at the Imperial Palace, 7 km east. A famous city's
 * notable-places row joins a geocoder's row of the same name this far off.
 */
const SAME_CITY_MAX_METERS = 15_000;

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
  /** A code typed in lower case, like a word ("lax"): meant, but less surely than a name. */
  codeAsWord: 0.9,
  prefix: 0.8,
  /** Every word typed starts a word of the name, one of them with a slip of one letter. */
  fuzzy: 0.75,
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
 * Text score at which a row may be what was meant without being picked: the
 * typed text is its name, starts its name, or starts it with one slip.
 */
export const CONFIDENT_TEXT_SCORE = TEXT_SCORE.fuzzy;

/** Text score of a row the typed words merely appear in, at word starts. */
export const WORD_MATCH_TEXT_SCORE = TEXT_SCORE.wordPrefix;

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
/** An administrative area of unknown rank. */
const DEFAULT_AREA_PROMINENCE = 0.3;
/** A named point of a settlement that is not one itself: a square, a house, a postcode. */
const MINOR_PLACE_PROMINENCE = 0.1;
/**
 * A railway station is a destination in its own right, unlike a car park or
 * a taxi rank named after it ("hbf" in Aachen means the station). Kept below
 * the bar for being meant from anywhere, so a far namesake stays obscure.
 */
const STATION_PROMINENCE = 0.25;
const STATION_RAW_CATEGORIES = new Set([
  "railway/station",
  "railway/halt",
  "public/transport/station",
  "building/train/station",
  "train/station",
]);

/** Recognize railway categories from both OSM-style and MapTiler spellings. */
export function isRailwayStationCategory(category: string | undefined): boolean {
  return STATION_RAW_CATEGORIES.has(category?.trim().toLowerCase().replace(/[ _]+/g, "/") ?? "");
}
/**
 * Weight of a provider's own order. Providers rank by fame we are not told
 * (Photon puts the Eiffel Tower in Paris before a garden and a peak of the
 * same name); among places that are all far away, that order is the only
 * fame signal left. Small enough that nearness still decides nearby.
 */
const PROVIDER_ORDER_WEIGHT = 0.08;
/** Share of a place's fame its name counts with while only partly typed. */
const PARTIAL_NAME_FAME_SHARE = 0.5;
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

/**
 * Words spelt more than one way, mapped to one form, so "Friedrichstr." and
 * "friedrichstraße" are the same street and "aachen hbf" names Aachen
 * Hauptbahnhof. A trailing "str" is the German abbreviation for Straße.
 */
const WORD_FORMS: ReadonlyArray<[RegExp, string]> = [
  [/ß/gu, "ss"],
  [/str(?= |$)/gu, "strasse"],
  [/(^| )hbf(?= |$)/gu, "$1hauptbahnhof"],
  [/(^| )bhf(?= |$)/gu, "$1bahnhof"],
];

/** A provider's own order for a row, set where the rows are gathered (`rankAutocompleteRows`). */
export type RankedSuggestion = AutocompleteResult & { providerRank?: number };

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
 * apostrophes dropped, so "kings cross" matches "King's Cross", and variant
 * spellings folded (see `WORD_FORMS`). Kept apart from `normalizeSearchTerm`,
 * which also keys stored search indexes.
 */
export function matchKey(raw: string): string {
  let key = normalizeSearchTerm(raw.replace(APOSTROPHES, ""));
  for (const [pattern, replacement] of WORD_FORMS) key = key.replace(pattern, replacement);
  return key;
}

function words(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

function everyTokenStartsAWord(tokens: string[], candidates: string[]): boolean {
  return tokens.every((token) => candidates.some((word) => word.startsWith(token)));
}

/** Whether `a` becomes `b` by one insertion, deletion, substitution or swap of neighbours. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const restA = a.slice(start, endA);
  const restB = b.slice(start, endB);
  if (restA.length <= 1 && restB.length <= 1) return true;
  return restA.length === 2 && restB.length === 2 && restA[0] === restB[1] && restA[1] === restB[0];
}

/**
 * Shortest text a near spelling is looked for at: below it one letter makes
 * a different word too easily.
 */
export const MIN_NEAR_SPELLING_LENGTH = 5;

/**
 * Slips a near spelling of `text` may have: one in a short name, two from
 * 8 letters on ("colloseum" is two from Colosseum).
 */
export function nearSpellingEdits(text: string): number {
  return text.length >= 8 ? 2 : 1;
}

/**
 * Edits that turn `a` into `b` (an insertion, deletion, substitution or swap
 * of neighbours each), counted only up to `limit + 1`.
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, beforePrevious[j - 2] + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return Math.min(previous[b.length], limit + 1);
}

/**
 * Whether `token` starts `word`, allowing one slip. Short words are left
 * exact: one letter changes "bank" into "band" or "bark".
 */
function startsWordLoosely(token: string, word: string, alone: boolean): boolean {
  if (word.startsWith(token)) return true;
  if (token.length < (alone ? 5 : 4)) return false;
  return [token.length - 1, token.length, token.length + 1].some(
    (length) => length <= word.length && withinOneEdit(token, word.slice(0, length)),
  );
}

/** Every token starts a word of `candidates`, at least one only with a slip of one letter. */
function everyTokenStartsAWordLoosely(tokens: string[], candidates: string[]): boolean {
  const alone = tokens.length === 1;
  return tokens.every((token) => candidates.some((word) => startsWordLoosely(token, word, alone)));
}

/**
 * The name as said in its own town, when it starts with the town the address
 * gives: "Aachen Hauptbahnhof" in Aachen is "hauptbahnhof", which "hbf" there
 * means. Undefined for a name that does not start with its town.
 */
function nameWithoutItsTown(item: AutocompleteResult): string | undefined {
  const labelWords = words(matchKey(item.label));
  if (labelWords.length < 2 || !item.sublabel) return undefined;
  // The address often repeats the name first; the town is in what follows.
  const rawAddress = item.sublabel.startsWith(item.label)
    ? item.sublabel.slice(item.label.length)
    : item.sublabel;
  return words(matchKey(rawAddress)).includes(labelWords[0])
    ? labelWords.slice(1).join(" ")
    : undefined;
}

/**
 * Whether the query is the row's whole name followed by words of its address:
 * "10115 berlin" for the postcode 10115 in Berlin, "paris france".
 */
function isNameWithItsPlace(key: string, label: string, context: string): boolean {
  if (!key.startsWith(`${label} `)) return false;
  return everyTokenStartsAWord(words(key.slice(label.length + 1)), words(context));
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
  if (match?.kind === "keyword") {
    // A tag is evidence of relevance, not the name: worth what a word of the
    // name would be, and no more than the name itself earns.
    const tagged =
      match.normalized === normalizedQuery
        ? TEXT_SCORE.wordPrefix
        : match.normalized.startsWith(normalizedQuery)
          ? TEXT_SCORE.contextWordPrefix
          : item.type === "category" && match.normalized.includes(normalizedQuery)
            ? TEXT_SCORE.contains
            : 0;
    return Math.max(tagged, textMatchScore({ ...item, searchMatch: undefined }, query));
  }
  if (match?.kind === "near_name") {
    // A typo of the name, as the provider found it; checked again here, so
    // only the slips a typo may have count.
    const edits = nearSpellingEdits(normalizedQuery);
    const near = editDistance(normalizedQuery, match.normalized, edits) <= edits;
    return Math.max(
      near ? TEXT_SCORE.fuzzy : 0,
      textMatchScore({ ...item, searchMatch: undefined }, query),
    );
  }
  if (match?.normalized === normalizedQuery) {
    // "bar", "art" and "spa" are words before they are airport codes; a code
    // counts as one when typed like one, "BAR".
    if (match.kind === "authoritative_code" && !isUppercaseAcronymIntent(query)) {
      return TEXT_SCORE.codeAsWord;
    }
    return exactMatchScore(match.kind);
  }
  // A category's name in the singular names it as fully: "museum" for Museums.
  if (item.type === "category" && match?.normalized === `${normalizedQuery}s`) {
    return exactMatchScore(match.kind);
  }
  if (match?.normalized.startsWith(normalizedQuery) && match.kind !== "generated_acronym") {
    return TEXT_SCORE.prefix;
  }

  if (
    (item.type === "brand" || item.type === "category") &&
    (match?.kind === "name" || match?.kind === "explicit_alias")
  ) {
    return Math.max(
      textMatchScore(
        { ...item, label: match.value, sublabel: undefined, searchMatch: undefined },
        query,
      ),
      textMatchScore({ ...item, searchMatch: undefined }, query),
    );
  }

  const key = matchKey(query);
  const label = matchKey(item.label);
  const context = matchKey(`${item.label} ${item.sublabel ?? ""}`);
  if (label === key || isNameWithItsPlace(key, label, context)) return TEXT_SCORE.exact;
  // A category's name in the singular names it as fully: "museum" for Museums.
  if (item.type === "category" && label === `${key}s`) return TEXT_SCORE.exact;
  if (label.startsWith(key)) return TEXT_SCORE.prefix;
  const local = nameWithoutItsTown(item);
  if (local === key) return TEXT_SCORE.exact;
  if (local?.startsWith(key)) return TEXT_SCORE.prefix;
  const tokens = words(key);
  const labelWords = words(label);
  // A slip of one letter in a name typed from its start ("potsdamer plaz").
  if (
    labelWords.length > 0 &&
    startsWordLoosely(tokens[0] ?? "", labelWords[0], tokens.length === 1) &&
    everyTokenStartsAWordLoosely(tokens, labelWords)
  ) {
    return TEXT_SCORE.fuzzy;
  }
  if (everyTokenStartsAWord(tokens, labelWords)) return TEXT_SCORE.wordPrefix;
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
function distanceFactor(
  item: AutocompleteResult,
  proximity?: LngLat,
  zoom?: number,
  reach = 1,
): number {
  const metres = proximityDistance(item, proximity);
  if (metres === UNKNOWN_PROXIMITY_METERS) return 0;
  const halfCreditKm = Math.min(
    MAX_HALF_CREDIT_KM,
    Math.max(MIN_HALF_CREDIT_KM, HALF_CREDIT_KM_AT_Z14 * 2 ** (14 - (zoom ?? DEFAULT_ZOOM))),
  );
  return 1 / (1 + metres / 1000 / (halfCreditKm * reach));
}

/**
 * How far a trip from the map reaches, in units of the nearby radius: from a
 * city map (5 km nearby at z14) Potsdam, 28 km out, is well within reach;
 * Oslo, 1,400 km out, is not.
 */
const TRIP_REACH = 10;

/**
 * Whether a place is plausibly where someone typing its name wants to go,
 * 0–1, leaving the name aside: famous enough to be meant from anywhere, or
 * within a trip of the map. An obscure namesake far away scores near 0.
 */
export function destinationPlausibility(
  item: AutocompleteResult,
  context: SuggestionScoreContext,
): number {
  return Math.max(fame(item, textMatchScore(item, context.query)), tripReach(item, context));
}

/** 1 on the map's centre, ½ at a trip's reach (see `TRIP_REACH`), 0 without a position. */
export function tripReach(item: AutocompleteResult, context: SuggestionScoreContext): number {
  return distanceFactor(item, context.proximity, context.zoom, TRIP_REACH);
}

/**
 * Whether two rows are one destination to go to, whatever each is called: a
 * square and its station, the Louvre museum and palace, a gate and the stop
 * named after it all lie within a short walk of each other.
 */
export function isSameDestination(a: AutocompleteResult, b: AutocompleteResult): boolean {
  if (!a.coordinates || !b.coordinates) return false;
  return haversineDistance(a.coordinates, b.coordinates) < SAME_PLACE_MAX_METERS;
}

/**
 * Whether the query names where the row is, beyond its name: a house number
 * or postcode that is part of its name ("hauptstraße 5", "10115"), or a word
 * of its address typed after the name ("10115 berlin", "paris france").
 */
export function queryNamesLocation(item: AutocompleteResult, query: string): boolean {
  const key = matchKey(query);
  const label = matchKey(item.label);
  const labelWords = words(label);
  if (words(key).some((token) => /\d/u.test(token) && labelWords.includes(token))) return true;
  return isNameWithItsPlace(key, label, matchKey(`${item.label} ${item.sublabel ?? ""}`));
}

/**
 * Fame of an area whose rank is not in `AREA_PROMINENCE`. Providers file
 * meadows, peaks and parks as areas too; those are no more a destination from
 * afar than any other place, so "mauerpark" finds the park, not the meadow in it.
 */
function unrankedAreaProminence(rawCategory?: string): number {
  const slash = rawCategory?.indexOf("/") ?? -1;
  const kind = rawCategory && slash !== -1 ? rawCategory.slice(0, slash) : rawCategory;
  if (kind === undefined || kind === "boundary") return DEFAULT_AREA_PROMINENCE;
  if (kind === "place") return MINOR_PLACE_PROMINENCE;
  return 0;
}

function rawCategoryValue(rawCategory?: string): string | undefined {
  if (!rawCategory) return undefined;
  const slash = rawCategory.lastIndexOf("/");
  return slash === -1 ? rawCategory : rawCategory.slice(slash + 1);
}

/**
 * How much of a destination a place is on its own, 0–1, wherever the map is:
 * its `fame` where known, else areas by settlement or admin rank, airports by
 * size, other places by a provider's importance, discounted.
 */
export function prominence(item: AutocompleteResult): number {
  return Math.max(rankedProminence(item), item.fame ?? 0);
}

function rankedProminence(item: AutocompleteResult): number {
  if (item.type === "region") {
    const byRank = AREA_PROMINENCE[rawCategoryValue(item.rawCategory) ?? ""];
    return item.importance ?? byRank ?? unrankedAreaProminence(item.rawCategory);
  }
  const importance = item.importance ?? 0;
  if (item.rawCategory === AIRPORT_RAW_CATEGORY) return importance * AIRPORT_PROMINENCE_SHARE;
  const own = importance * PLACE_PROMINENCE_SHARE;
  return isRailwayStationCategory(item.rawCategory) ? Math.max(own, STATION_PROMINENCE) : own;
}

export function isPlaceRow(item: AutocompleteResult): boolean {
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
export function suggestionScore(item: RankedSuggestion, context: SuggestionScoreContext): number {
  const text = textMatchScore(item, context.query);
  if (!isPlaceRow(item)) return text + DISTANCE_WEIGHT * localityScore(item, context);
  const order =
    item.providerRank === undefined ? 0 : PROVIDER_ORDER_WEIGHT / (1 + item.providerRank);
  return (
    text +
    DISTANCE_WEIGHT * localityScore(item, context) +
    PROMINENCE_WEIGHT * fame(item, text) +
    order
  );
}

/** Prominence, raised for an official code or alias typed out in full. */
function fame(item: AutocompleteResult, text: number): number {
  // Fame earned by a name only partly typed counts half: "paris" means Paris
  // before it means Pariser Platz, however well known the square.
  const own =
    text >= TEXT_SCORE.exact
      ? prominence(item)
      : Math.max(rankedProminence(item), (item.fame ?? 0) * PARTIAL_NAME_FAME_SHARE);
  return text >= TEXT_SCORE.exactExplicit
    ? EXPLICIT_MATCH_PROMINENCE + (1 - EXPLICIT_MATCH_PROMINENCE) * own
    : own;
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
  const maxMeters = isCityFromTwoSources(a, b) ? SAME_CITY_MAX_METERS : SAME_PLACE_MAX_METERS;
  return haversineDistance(a.coordinates, b.coordinates) < maxMeters;
}

/**
 * Two areas of one name, only one of them tied to a Wikidata item: a city
 * as the notable-places index knows it, and a geocoder's record of it. Two
 * geocoder rows keep the short distance, so namesake villages stay apart.
 */
function isCityFromTwoSources(a: AutocompleteResult, b: AutocompleteResult): boolean {
  return (
    a.type === "region" &&
    b.type === "region" &&
    Boolean(a.ids?.wikidata) !== Boolean(b.ids?.wikidata)
  );
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
  query: string,
): AutocompleteResult {
  const contributingProviders = [...providerIds(stronger)];
  for (const provider of providerIds(weaker)) {
    if (!contributingProviders.includes(provider)) contributingProviders.push(provider);
  }
  const sourceIds = [...new Set([...(stronger.sourceIds ?? []), ...(weaker.sourceIds ?? [])])];
  // A geocoder's row for the Louvre and the notable-places row are one place;
  // it keeps the fame either of them knew.
  const fame = Math.max(stronger.fame ?? 0, weaker.fame ?? 0);
  // The name it was found by, for a row that says nothing of it and only
  // matches by its label less well: a geocoder's Rome only starts with
  // "rom", which is Rome's German name. A row's own match stays: an airport
  // matched by its code is not matched by the same code as a name.
  const searchMatch =
    !stronger.searchMatch &&
    weaker.searchMatch &&
    textMatchScore({ ...stronger, searchMatch: weaker.searchMatch }, query) >
      textMatchScore(stronger, query)
      ? weaker.searchMatch
      : stronger.searchMatch;
  return {
    ...stronger,
    ...(searchMatch ? { searchMatch } : {}),
    ids:
      stronger.ids || weaker.ids ? { ...(weaker.ids ?? {}), ...(stronger.ids ?? {}) } : undefined,
    ...(fame > 0 ? { fame } : {}),
    contributingProviders: contributingProviders.length > 0 ? contributingProviders : undefined,
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
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
    else {
      merged[duplicateIndex] = mergeDuplicate(
        merged[duplicateIndex],
        normalizedItem,
        context.query,
      );
    }
  }

  return merged;
}
