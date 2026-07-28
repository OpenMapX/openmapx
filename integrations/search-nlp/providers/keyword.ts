import { categoriesToFilter } from "@openmapx/core";
import type { NlpProvider, ParseContext, SearchIntent } from "../types";

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(coffee|cafe|café|espresso|latte)\b/i, "cafes"],
  [/\b(restaurant|food|eat|dinner|lunch|dining)\b/i, "restaurants"],
  [/\b(bar|pub|beer|wine|drinks?)\b/i, "bars"],
  [/\b(pharmacy|chemist|drugstore)\b/i, "pharmacies"],
  [/\b(hotel|hostel|motel|accommodation)\b/i, "hotels"],
  [/\b(museum|gallery)\b/i, "museums"],
  [/\b(hospital|emergency room|er)\b/i, "hospitals"],
  [/\b(park|garden)\b/i, "parks"],
  [/\b(supermarket|grocery|groceries)\b/i, "supermarkets"],
  [/\b(atm|cash machine)\b/i, "atms"],
  [/\b(fuel|petrol|gas station|gasoline)\b/i, "fuel"],
  [/\b(charging|ev charger|charge my (car|ev))\b/i, "ev_charging"],
  [/\b(parking|car park)\b/i, "parking"],
];

const ATTRIBUTE_KEYWORDS: Array<[RegExp, [string, string]]> = [
  [/\b(outdoor|terrace|patio|outside seating)\b/i, ["outdoor_seating", "yes"]],
  [/\b(wifi|wi-fi|internet)\b/i, ["internet_access", "wlan"]],
  [/\b(wheelchair|accessible|step.?free)\b/i, ["wheelchair", "yes"]],
  [/\bvegan\b/i, ["diet:vegan", "yes"]],
  [/\bvegetarian\b/i, ["diet:vegetarian", "yes"]],
  [/\bhalal\b/i, ["diet:halal", "yes"]],
  [/\b(takeaway|take.?out)\b/i, ["takeaway", "yes"]],
  [/\bdelivery\b/i, ["delivery", "yes"]],
];

// Generic nouns that commonly appear in category phrases; Title-case versions of these
// do NOT indicate a proper name (e.g. "Coffee Shop", "Gas Station").
const GENERIC_NOUNS = new Set([
  "shop",
  "store",
  "station",
  "market",
  "hall",
  "house",
  "lot",
  "centre",
  "center",
  "court",
  "square",
  "park",
  "bar",
  "pub",
  "club",
  "place",
  "spot",
  "area",
  "point",
]);

// Common function words that add no name-signal.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "near",
  "nearest",
  "closest",
  "by",
  "with",
  "and",
  "or",
  "in",
  "on",
  "at",
  "me",
  "my",
  "open",
  "now",
  "to",
  "of",
  "for",
  "around",
  "close",
]);

/**
 * Collect all character index ranges in `text` that are covered by any of
 * the given patterns (using global exec loop to find all matches).
 */
function coveredRanges(text: string, patterns: RegExp[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of patterns) {
    const globalRe = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    let m = globalRe.exec(text);
    while (m !== null) {
      ranges.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) globalRe.lastIndex++;
      m = globalRe.exec(text);
    }
  }
  return ranges;
}

/**
 * Returns true when the query looks like a proper name (e.g. "Cafe Central", "Hotel Adlon")
 * rather than a generic category phrase (e.g. "Coffee Shop", "Gas Station").
 *
 * A query is treated as a proper name only when, after excluding tokens whose
 * positions are covered by a keyword match in the full query, or whose
 * lowercased form is a generic noun or stopword, at least one Title-case token
 * remains unaccounted for. Single-word queries are never suppressed.
 */
function looksLikeProperName(originalQuery: string): boolean {
  const q = originalQuery.trim();
  const tokens = q
    .split(/\s+/)
    .map((w) => w.replace(/^\p{P}+|\p{P}+$/gu, ""))
    .filter(Boolean);

  if (tokens.length < 2) return false;

  const titleCaseTokens = tokens.filter((w) => /^\p{Lu}/u.test(w));
  if (titleCaseTokens.length === 0) return false;

  const lower = q.toLowerCase();
  const categoryPatterns = CATEGORY_KEYWORDS.map(([re]) => re);
  const attributePatterns = ATTRIBUTE_KEYWORDS.map(([re]) => re);
  const covered = coveredRanges(lower, [...categoryPatterns, ...attributePatterns]);

  const unrecognized = titleCaseTokens.filter((w) => {
    const wLower = w.toLowerCase();
    if (STOPWORDS.has(wLower) || GENERIC_NOUNS.has(wLower)) return false;
    const idx = lower.indexOf(wLower);
    if (idx !== -1 && covered.some(([s, e]) => idx >= s && idx + wLower.length <= e)) return false;
    return true;
  });

  return unrecognized.length > 0;
}

export const keywordProvider: NlpProvider = {
  id: "keyword",
  label: "Keyword parser",
  cacheKey: "keyword:v1",
  isAi: false,
  requiresNetwork: false,
  cloudProcessors: [],
  async parseQuery(query: string, _ctx: ParseContext): Promise<SearchIntent> {
    const q = query.toLowerCase();

    const categories = [
      ...new Set(CATEGORY_KEYWORDS.filter(([re]) => re.test(q)).map(([, id]) => id)),
    ];

    const attributes: Record<string, string> = {};
    for (const [re, [k, v]] of ATTRIBUTE_KEYWORDS) {
      if (re.test(q)) attributes[k] = v;
    }

    let time_constraint: SearchIntent["time_constraint"] = null;
    if (/\bopen now\b/.test(q)) {
      time_constraint = { type: "open_now" };
    } else if (/\b(24.?hours?|24h|all night)\b/.test(q)) {
      time_constraint = { type: "open_24h" };
    }

    const sort_by: SearchIntent["sort_by"] = /\b(nearest|closest|near me)\b/.test(q)
      ? "distance"
      : "relevance";

    const hasMatch = categories.length > 0;
    const suppressed = looksLikeProperName(query);
    const confidence = hasMatch && !suppressed ? 0.6 : 0.2;

    const effectiveCategories = suppressed ? [] : categories;
    return {
      filter: categoriesToFilter(effectiveCategories, attributes) ?? { selectors: [] },
      spatial_constraint: { type: "current_view" },
      time_constraint,
      sort_by,
      unmapped_attributes: [],
      confidence,
      explanation: suppressed
        ? "Looks like a specific place name"
        : hasMatch
          ? `${categories.join(", ")} search`
          : "No clear category detected",
    };
  },
};
