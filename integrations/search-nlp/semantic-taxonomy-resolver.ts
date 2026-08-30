import { suggestBrands } from "@openmapx/brands";
import {
  isUppercaseAcronymIntent,
  normalizeFilter,
  normalizeSearchTerm,
  type SearchIntent,
} from "@openmapx/core";
import { isPlausibleNlSearch } from "@openmapx/integration-framework";
import type { SemanticCategoryDocument } from "@openmapx/presets";
import { looksLikeProperName } from "./providers/keyword.js";
import type { SemanticCategoryIndex } from "./semantic-category-index.js";
import {
  type SemanticCalibration,
  SemanticEmbeddingError,
  type SemanticResolutionOutcome,
  type SemanticScoreResult,
} from "./semantic-taxonomy-types.js";

export interface SemanticResolutionDecision {
  intent: SearchIntent;
  outcome: SemanticResolutionOutcome;
  applied: boolean;
}

export type SemanticPolicyDecision =
  | { kind: "needs-score" }
  | ({ kind: "decided" } & SemanticResolutionDecision);

export interface SemanticTaxonomyResolver {
  resolve(input: {
    query: string;
    lang?: string;
    intent: SearchIntent;
    signal: AbortSignal;
    shadow: boolean;
  }): Promise<SemanticResolutionDecision>;
}

const GERMAN_REQUEST_CUES = [
  "wo",
  "suche",
  "suchen",
  "finde",
  "finden",
  "brauche",
  "brauchen",
  "möchte",
  "irgendwo",
  "in der nähe",
  "zum",
  "zur",
];

const GERMAN_GENERIC_MODIFIERS = new Set([
  "nah",
  "nahe",
  "näher",
  "nächste",
  "nächster",
  "ruhig",
  "ruhige",
  "günstig",
  "günstige",
  "geöffnet",
  "barrierefrei",
  "barrierefreie",
  "gut",
  "gute",
  "beste",
  "besten",
]);

function language(input: string | undefined): "en" | "de" {
  return input?.toLowerCase().split("-")[0] === "de" ? "de" : "en";
}

function looksLikeUrl(query: string): boolean {
  return /^(?:https?:\/\/|www\.)/i.test(query.trim());
}

export function looksLikeAddressOrCodeIntent(query: string): boolean {
  const value = query.trim();
  if (/^[+-]?\d{1,2}(?:\.\d+)?\s*[, ]\s*[+-]?\d{1,3}(?:\.\d+)?$/.test(value)) {
    return true;
  }
  if (/^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?:\s+\p{L}.*)?$/iu.test(value)) {
    return true;
  }
  if (/^\d{4,6}\s+\p{L}[\p{L}\p{M} .'-]+$/u.test(value)) return true;
  if (
    /^(?:\d+[A-Za-z]?\s+)?[\p{L}\p{M}.'-]+(?:straße|strasse|street|road|avenue|lane|platz|weg)\s+\d+[A-Za-z]?$/iu.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /^\d+[A-Za-z]?\s+[\p{L}\p{M}.' -]+(?:street|road|avenue|lane|straße|strasse|weg)$/iu.test(value)
  ) {
    return true;
  }
  return /^(?:[A-Z]\d+|[A-Z]\d{1,3})\s+(?:exit|ausfahrt)\s+\d+$/i.test(value);
}

export function looksLikeGermanProperName(
  query: string,
  catalog: readonly SemanticCategoryDocument[],
): boolean {
  const trimmed = query.trim();
  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/^\p{P}+|\p{P}+$/gu, ""))
    .filter(Boolean);
  if (tokens.length < 2) return false;
  const normalized = normalizeSearchTerm(trimmed);
  if (GERMAN_REQUEST_CUES.some((cue) => normalized.includes(normalizeSearchTerm(cue))))
    return false;
  const covered = new Set<string>();
  for (const category of catalog) {
    const phrases = [category.labels.de, ...category.document.split(/[,.\n:]+/)];
    for (const phrase of phrases) {
      for (const token of normalizeSearchTerm(phrase).split(" ")) covered.add(token);
    }
  }
  return tokens.some((token) => {
    if (!/^\p{Lu}/u.test(token)) return false;
    const normalizedToken = normalizeSearchTerm(token);
    return !covered.has(normalizedToken) && !GERMAN_GENERIC_MODIFIERS.has(normalizedToken);
  });
}

function exactBrand(query: string): boolean {
  const normalized = normalizeSearchTerm(query);
  const [top] = suggestBrands(query, undefined, 1);
  return top !== undefined && normalizeSearchTerm(top.name) === normalized;
}

function selectorSignature(intent: SearchIntent): string {
  return JSON.stringify(normalizeFilter({ selectors: intent.filter.selectors }).selectors);
}

function categorySignature(category: SemanticCategoryDocument): string {
  return JSON.stringify(normalizeFilter({ selectors: category.filter.selectors }).selectors);
}

function decided(
  intent: SearchIntent,
  outcome: SemanticResolutionOutcome,
  applied = false,
): SemanticPolicyDecision {
  return { kind: "decided", intent, outcome, applied };
}

export function planSemanticResolution(input: {
  query: string;
  lang?: string;
  intent: SearchIntent;
  calibration: SemanticCalibration;
  catalog: readonly SemanticCategoryDocument[];
  score?: SemanticScoreResult;
  shadow: boolean;
}): SemanticPolicyDecision {
  const query = input.query.trim();
  if (!query || query.length > 160 || !/\p{L}/u.test(query)) {
    return decided(input.intent, { status: "abstained", reason: "not-eligible" });
  }
  if (
    looksLikeUrl(query) ||
    looksLikeAddressOrCodeIntent(query) ||
    isUppercaseAcronymIntent(query)
  ) {
    return decided(input.intent, { status: "abstained", reason: "address-code" });
  }
  if (exactBrand(query)) {
    return decided(input.intent, { status: "abstained", reason: "brand" });
  }
  const lang = language(input.lang);
  const properName =
    lang === "de" ? looksLikeGermanProperName(query, input.catalog) : looksLikeProperName(query);
  if (properName) {
    return decided(input.intent, { status: "abstained", reason: "proper-name" });
  }
  if (!input.shadow && isPlausibleNlSearch(input.intent)) {
    return decided(input.intent, { status: "abstained", reason: "already-plausible" });
  }
  if (!input.score) return { kind: "needs-score" };
  if (input.score.top.score < input.calibration.minimumScore) {
    return decided(input.intent, { status: "abstained", reason: "below-score" });
  }
  if (input.score.margin < input.calibration.minimumMargin) {
    return decided(input.intent, { status: "abstained", reason: "below-margin" });
  }
  const category = input.catalog.find(
    ({ categoryId }) => categoryId === input.score?.top.categoryId,
  );
  if (!category) {
    return decided(input.intent, { status: "unavailable", reason: "invalid-response" });
  }
  const outcome: SemanticResolutionOutcome = {
    status: "matched",
    categoryId: category.categoryId,
    score: input.score.top.score,
    margin: input.score.margin,
  };
  if (input.shadow) return decided(input.intent, outcome);

  const currentSelectors = input.intent.filter.selectors;
  if (
    currentSelectors.length > 0 &&
    selectorSignature(input.intent) !== categorySignature(category)
  ) {
    return decided(input.intent, { status: "abstained", reason: "selector-conflict" });
  }
  const explanation =
    lang === "de" ? `Suche nach ${category.labels.de}` : `Search for ${category.labels.en}`;
  const nextIntent: SearchIntent = {
    ...input.intent,
    filter: {
      ...input.intent.filter,
      selectors:
        currentSelectors.length === 0
          ? category.filter.selectors.map((selector) => ({
              tags: selector.tags.map((predicate) => ({ ...predicate })),
            }))
          : currentSelectors,
    },
    confidence: Math.max(input.intent.confidence, input.calibration.activationConfidence),
    explanation,
  };
  return decided(nextIntent, outcome, true);
}

export function createSemanticTaxonomyResolver(options: {
  index: SemanticCategoryIndex;
  calibration: SemanticCalibration;
  catalog: readonly SemanticCategoryDocument[];
}): SemanticTaxonomyResolver {
  return {
    async resolve(input) {
      const preflight = planSemanticResolution({
        ...input,
        calibration: options.calibration,
        catalog: options.catalog,
      });
      if (preflight.kind === "decided") return preflight;
      try {
        const score = await options.index.score(input.query, input.signal);
        const result = planSemanticResolution({
          ...input,
          calibration: options.calibration,
          catalog: options.catalog,
          score,
        });
        if (result.kind === "needs-score") {
          throw new SemanticEmbeddingError(
            "invalid-response",
            "Policy requested a duplicate score",
          );
        }
        return result;
      } catch (error) {
        if (error instanceof SemanticEmbeddingError) {
          return {
            intent: input.intent,
            outcome: { status: "unavailable", reason: error.reason },
            applied: false,
          };
        }
        throw error;
      }
    },
  };
}
