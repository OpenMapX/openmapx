export type RouteQuery = Record<string, string | string[] | undefined>;

export class QueryValidationError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`Query parameter "${key}" ${message}`);
    this.name = "QueryValidationError";
    this.key = key;
  }
}

/** Read a query key whose contract permits at most one occurrence. */
export function scalarQuery(query: RouteQuery, key: string): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) throw new QueryValidationError(key, "must appear once");
  return value;
}

/**
 * Read a query key whose contract permits repetition (`k=a&k=b`). Each
 * occurrence is one item, kept verbatim: nothing is split or trimmed, so an
 * item may hold any character. `undefined` when the key is absent.
 */
export function listQuery(query: RouteQuery, key: string): string[] | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value];
}

/**
 * Validate a legacy route whose entire query contract is scalar. New routes
 * should normally name keys with `scalarQuery`; this adapter keeps existing
 * parser boundaries truthful while the raw dispatcher preserves arrays.
 */
export function scalarQueries(query: RouteQuery): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(query)) {
    const value = scalarQuery(query, key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}
