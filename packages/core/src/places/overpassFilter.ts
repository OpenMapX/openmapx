import type { PoiSearchOutcome } from "../types/category";
import type { BoundingBox } from "../types/geometry";
import type { CategoryPlaceResult } from "./overpass.service";
import {
  CATEGORY_FILTERS,
  escapeOverpassLiteral,
  overpassOutStatement,
  overpassPoiSearch,
} from "./overpass.service";

/**
 * Escape regex metacharacters for filter `~` predicates. `|` is intentionally
 * preserved so the model can express alternation (e.g. `yes|only`). Catastrophic
 * backtracking is bounded by the server `[timeout:15]`.
 */
function escapeFilterRegexValue(value: string): string {
  return value.replace(/[\\.*+?()[\]{}^$"]/g, "\\$&");
}

export type TagOp = "=" | "~" | "exists";

export interface TagPredicate {
  key: string;
  op?: TagOp;
  value?: string;
}

export interface FilterSelector {
  tags: TagPredicate[];
}

export interface OverpassFilter {
  selectors: FilterSelector[];
  require?: TagPredicate[];
  exclude?: TagPredicate[];
  elementTypes?: ("node" | "way" | "relation")[];
}

export const FILTER_LIMITS = {
  MAX_SELECTORS: 12,
  MAX_PREDS_PER_LIST: 8,
  MAX_TOTAL_PREDS: 40,
  MAX_VALUE_LEN: 60,
  MAX_REGEX_LEN: 120,
} as const;

type ValidResult = { ok: true; filter: OverpassFilter };
type InvalidResult = { ok: false; error: string };

const KEY_REGEX = /^[a-zA-Z][a-zA-Z0-9_:]{0,40}$/;

const VALID_OPS = new Set<string>(["=", "~", "exists"]);

const VALID_ELEMENT_TYPES = new Set<string>(["node", "way", "relation"]);

function err(message: string): InvalidResult {
  return { ok: false, error: message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validatePredicate(raw: unknown, index: number, context: string): TagPredicate | string {
  if (!isRecord(raw)) return `${context}[${index}]: predicate must be an object`;

  const key = raw.key;
  if (typeof key !== "string") return `${context}[${index}].key must be a string`;
  if (!KEY_REGEX.test(key)) return `${context}[${index}].key "${key}" contains invalid characters`;

  const rawOp = raw.op;
  let op: TagOp;
  if (rawOp === undefined || rawOp === null) {
    op = "=";
  } else if (typeof rawOp === "string" && VALID_OPS.has(rawOp)) {
    op = rawOp as TagOp;
  } else {
    return `${context}[${index}].op must be one of "=", "~", "exists"`;
  }

  if (op === "exists") {
    return { key, op };
  }

  const rawValue = raw.value;
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    return `${context}[${index}].value is required and must be non-empty for op "${op}"`;
  }

  if (op === "=" && rawValue.length > FILTER_LIMITS.MAX_VALUE_LEN) {
    return `${context}[${index}].value exceeds max length ${FILTER_LIMITS.MAX_VALUE_LEN} for op "="`;
  }

  if (op === "~" && rawValue.length > FILTER_LIMITS.MAX_REGEX_LEN) {
    return `${context}[${index}].value exceeds max regex length ${FILTER_LIMITS.MAX_REGEX_LEN}`;
  }

  return { key, op, value: rawValue };
}

function validatePredicateList(
  raw: unknown,
  context: string,
  minLen: number,
  maxLen: number,
): TagPredicate[] | string {
  if (!Array.isArray(raw)) return `${context} must be an array`;
  if (raw.length < minLen) return `${context} must have at least ${minLen} predicate(s)`;
  if (raw.length > maxLen) return `${context} must have at most ${maxLen} predicate(s)`;

  const result: TagPredicate[] = [];
  for (let i = 0; i < raw.length; i++) {
    const pred = validatePredicate(raw[i], i, context);
    if (typeof pred === "string") return pred;
    result.push(pred);
  }
  return result;
}

export function validateOverpassFilter(input: unknown): ValidResult | InvalidResult {
  if (!isRecord(input)) return err("input must be an object");

  const rawSelectors = input.selectors;
  if (!Array.isArray(rawSelectors)) return err("selectors must be an array");
  if (rawSelectors.length < 1) return err("selectors must have at least 1 entry");
  if (rawSelectors.length > FILTER_LIMITS.MAX_SELECTORS) {
    return err(`selectors must have at most ${FILTER_LIMITS.MAX_SELECTORS} entries`);
  }

  const selectors: FilterSelector[] = [];
  for (let i = 0; i < rawSelectors.length; i++) {
    const rawSel = rawSelectors[i];
    if (!isRecord(rawSel)) return err(`selectors[${i}] must be an object`);

    const tagsResult = validatePredicateList(
      rawSel.tags,
      `selectors[${i}].tags`,
      1,
      FILTER_LIMITS.MAX_PREDS_PER_LIST,
    );
    if (typeof tagsResult === "string") return err(tagsResult);
    selectors.push({ tags: tagsResult });
  }

  let requirePreds: TagPredicate[] | undefined;
  if (input.require !== undefined) {
    const result = validatePredicateList(
      input.require,
      "require",
      0,
      FILTER_LIMITS.MAX_PREDS_PER_LIST,
    );
    if (typeof result === "string") return err(result);
    requirePreds = result;
  }

  let excludePreds: TagPredicate[] | undefined;
  if (input.exclude !== undefined) {
    const result = validatePredicateList(
      input.exclude,
      "exclude",
      0,
      FILTER_LIMITS.MAX_PREDS_PER_LIST,
    );
    if (typeof result === "string") return err(result);
    excludePreds = result;
  }

  const totalPreds =
    selectors.reduce((sum, s) => sum + s.tags.length, 0) +
    (requirePreds?.length ?? 0) +
    (excludePreds?.length ?? 0);

  if (totalPreds > FILTER_LIMITS.MAX_TOTAL_PREDS) {
    return err(
      `total predicate count ${totalPreds} exceeds maximum ${FILTER_LIMITS.MAX_TOTAL_PREDS}`,
    );
  }

  let elementTypes: ("node" | "way" | "relation")[] | undefined;
  if (input.elementTypes !== undefined) {
    const rawTypes = input.elementTypes;
    if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
      return err("elementTypes must be a non-empty array");
    }
    const types: ("node" | "way" | "relation")[] = [];
    for (const t of rawTypes) {
      if (typeof t !== "string" || !VALID_ELEMENT_TYPES.has(t)) {
        return err(`elementTypes contains invalid value: "${t}"`);
      }
      types.push(t as "node" | "way" | "relation");
    }
    elementTypes = types;
  }

  const filter: OverpassFilter = {
    selectors,
    elementTypes: elementTypes ?? ["node", "way"],
  };
  if (requirePreds !== undefined) filter.require = requirePreds;
  if (excludePreds !== undefined) filter.exclude = excludePreds;

  return { ok: true, filter };
}

function compilePredicate(pred: TagPredicate, exclude: boolean): string {
  const k = escapeOverpassLiteral(pred.key);
  if (pred.op === "exists") {
    return exclude ? `["${k}"!~"."]` : `["${k}"]`;
  }
  const v = pred.value ?? "";
  if (pred.op === "~") {
    const rv = escapeFilterRegexValue(v);
    return exclude ? `["${k}"!~"${rv}"]` : `["${k}"~"${rv}"]`;
  }
  const lv = escapeOverpassLiteral(v);
  return exclude ? `["${k}"!="${lv}"]` : `["${k}"="${lv}"]`;
}

/**
 * Compile a validated `OverpassFilter` to an Overpass QL query string.
 * Selectors are OR-ed; require and exclude predicates are AND-ed onto every
 * line. The result is wrapped in `[out:json][timeout:15]` and bounded by the
 * shared Overpass fetch ceiling.
 */
export function buildFilterQuery(filter: OverpassFilter, bbox: BoundingBox): string {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const elementTypes = filter.elementTypes ?? ["node", "way"];

  const requireStr = (filter.require ?? []).map((p) => compilePredicate(p, false)).join("");
  const excludeStr = (filter.exclude ?? []).map((p) => compilePredicate(p, true)).join("");

  const lines: string[] = [];
  for (const selector of filter.selectors) {
    const selectorStr = selector.tags.map((p) => compilePredicate(p, false)).join("");
    for (const type of elementTypes) {
      lines.push(`${type}${selectorStr}${requireStr}${excludeStr}(${bboxStr});`);
    }
  }

  return `[out:json][timeout:15];\n(\n  ${lines.join("\n  ")}\n);\n${overpassOutStatement()}`;
}

function sortPredicates(preds: TagPredicate[]): TagPredicate[] {
  return [...preds].sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    const aOp = a.op ?? "=";
    const bOp = b.op ?? "=";
    if (aOp !== bOp) return aOp < bOp ? -1 : 1;
    const aVal = a.value ?? "";
    const bVal = b.value ?? "";
    return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
  });
}

function serializeTags(tags: TagPredicate[]): string {
  return tags.map((t) => `${t.key}|${t.op ?? "="}|${t.value ?? ""}`).join(",");
}

/**
 * Return a new `OverpassFilter` with all arrays in deterministic order so the
 * same logical filter always serializes to the same JSON string. Used only for
 * cache-key hashing — never for emitting QL.
 */
export function normalizeFilter(filter: OverpassFilter): OverpassFilter {
  const selectors = [...filter.selectors]
    .map((s) => ({ tags: sortPredicates(s.tags) }))
    .sort((a, b) => {
      const sa = serializeTags(a.tags);
      const sb = serializeTags(b.tags);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

  const result: OverpassFilter = { selectors };
  if (filter.require !== undefined && filter.require.length > 0)
    result.require = sortPredicates(filter.require);
  if (filter.exclude !== undefined && filter.exclude.length > 0)
    result.exclude = sortPredicates(filter.exclude);
  if (filter.elementTypes !== undefined) result.elementTypes = [...filter.elementTypes].sort();
  return result;
}

/**
 * Build an `OverpassFilter` from a list of category IDs and optional attribute
 * constraints. Each known category entry in `CATEGORY_FILTERS` contributes one
 * selector per `{key,value}` pair (OR semantics across selectors). Attribute
 * keys are ANDed as `require` predicates; `cuisine` uses regex (`~`), all
 * others use exact match (`=`). Returns `null` if none of the given IDs map to
 * a known category.
 */
export function categoriesToFilter(
  categoryIds: string[],
  attributes: Record<string, string>,
): OverpassFilter | null {
  const selectors: FilterSelector[] = [];
  for (const id of categoryIds) {
    const filters = CATEGORY_FILTERS[id];
    if (!filters) continue;
    for (const { key, value } of filters) {
      selectors.push({ tags: [{ key, op: "=", value }] });
    }
  }
  if (selectors.length === 0) return null;

  const require: TagPredicate[] = Object.entries(attributes).map(([key, value]) =>
    key === "cuisine" ? { key, op: "~" as TagOp, value } : { key, op: "=" as TagOp, value },
  );

  const filter: OverpassFilter = { selectors };
  if (require.length > 0) filter.require = require;
  return filter;
}

/**
 * Search Overpass using a structured `OverpassFilter`. Compiles the filter to
 * Overpass QL via `buildFilterQuery`, executes the query, and maps the raw
 * elements to `CategoryPlaceResult[]`. Mirrors `searchByOsmTags`.
 */
export async function searchByFilter(
  filter: OverpassFilter,
  bbox: BoundingBox,
): Promise<PoiSearchOutcome> {
  return overpassPoiSearch(buildFilterQuery(filter, bbox));
}

/**
 * Return a new `OverpassFilter` with the predicate at `index` removed from
 * `filter[list]`. Pure — the original is never mutated. If removing the
 * predicate empties the list, the key is omitted entirely so that
 * `normalizeFilter` hashing stays consistent (empty vs absent).
 * An out-of-range index is a no-op.
 */
export function removeFilterPredicate(
  filter: OverpassFilter,
  list: "require" | "exclude",
  index: number,
): OverpassFilter {
  const current = filter[list];
  if (!current || index < 0 || index >= current.length) {
    return filter;
  }
  const updated = current.filter((_, i) => i !== index);
  const result: OverpassFilter = { ...filter };
  if (updated.length === 0) {
    delete result[list];
  } else {
    result[list] = updated;
  }
  return result;
}

export type { CategoryPlaceResult };
