import type { AutocompleteResult } from "../types/geocoding";
import type { LngLat } from "../types/geometry";
import type { Ids } from "../types/identified";
import type { SearchMatchKind } from "../types/searchSuggestion";
import { haversineDistance } from "./coordinates";

const MAX_PROXIMITY_METERS = 100_000;
const COORDINATE_DEDUPE_SQUARED_DEGREES = 0.0001;

const MATCH_TIERS: Record<SearchMatchKind, number> = {
  authoritative_code: 400,
  explicit_reference: 300,
  explicit_alias: 300,
  name: 200,
  generated_acronym: 100,
};

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

export function searchMatchTier(kind?: SearchMatchKind): number {
  return MATCH_TIERS[kind ?? "name"];
}

function textualScore(item: AutocompleteResult, normalizedQuery: string): number {
  if (!normalizedQuery) return 0;
  const match = item.searchMatch?.normalized;
  if (match === normalizedQuery) return 3;
  if (match?.startsWith(normalizedQuery)) return 2;
  const label = normalizeSearchTerm(item.label);
  if (label === normalizedQuery) return 1;
  return label.startsWith(normalizedQuery) ? 0.5 : 0;
}

function proximityDistance(item: AutocompleteResult, proximity?: LngLat): number {
  if (!proximity || !item.coordinates) return MAX_PROXIMITY_METERS;
  return Math.min(haversineDistance(item.coordinates, proximity), MAX_PROXIMITY_METERS);
}

export function compareSearchSuggestions(
  a: AutocompleteResult,
  b: AutocompleteResult,
  proximity?: LngLat,
): number;
export function compareSearchSuggestions(
  a: AutocompleteResult,
  b: AutocompleteResult,
  query: string,
  proximity?: LngLat,
): number;
export function compareSearchSuggestions(
  a: AutocompleteResult,
  b: AutocompleteResult,
  queryOrProximity?: string | LngLat,
  optionalProximity?: LngLat,
): number {
  const query = typeof queryOrProximity === "string" ? queryOrProximity : "";
  const proximity = Array.isArray(queryOrProximity) ? queryOrProximity : optionalProximity;
  const tierDifference =
    searchMatchTier(b.searchMatch?.kind) - searchMatchTier(a.searchMatch?.kind);
  if (tierDifference !== 0) return tierDifference;

  const normalizedQuery = normalizeSearchTerm(query);
  const textualDifference = textualScore(b, normalizedQuery) - textualScore(a, normalizedQuery);
  if (textualDifference !== 0) return textualDifference;

  const importanceDifference = (b.importance ?? 0) - (a.importance ?? 0);
  if (importanceDifference !== 0) return importanceDifference;

  const proximityDifference = proximityDistance(a, proximity) - proximityDistance(b, proximity);
  if (proximityDifference !== 0) return proximityDifference;

  return a.id.localeCompare(b.id);
}

function hasSharedIdentity(a?: Ids, b?: Ids): boolean {
  if (!a || !b) return false;
  return Object.entries(a).some(([namespace, value]) => value !== "" && b[namespace] === value);
}

function hasSameCanonicalLocation(a: AutocompleteResult, b: AutocompleteResult): boolean {
  if (!a.coordinates || !b.coordinates) return false;
  if (normalizeSearchTerm(a.label) !== normalizeSearchTerm(b.label)) return false;
  const lngDelta = a.coordinates[0] - b.coordinates[0];
  const latDelta = a.coordinates[1] - b.coordinates[1];
  return lngDelta * lngDelta + latDelta * latDelta < COORDINATE_DEDUPE_SQUARED_DEGREES;
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
  query: string,
  proximity?: LngLat,
): AutocompleteResult[] {
  const sorted = [...items].sort((a, b) => compareSearchSuggestions(a, b, query, proximity));
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
