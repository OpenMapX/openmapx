import type { QueryKey } from "@tanstack/react-query";

/**
 * Returns a `placeholderData` function for React Query that keeps previous results
 * only when the new query is a prefix continuation of the old one ("Ful" → "Fuld").
 * Clears immediately when the query is unrelated ("Fulda" → "B") or when any other
 * key part (language, location) differs.
 *
 * React Query passes the last query that had data, so the decision does not
 * depend on when it calls this function relative to rendering.
 */
export function usePrefixPlaceholder<T>(
  queryKeyPrefix: string,
  query: string,
  ...extraKeyParts: unknown[]
): (previousData: T | undefined, previousQuery?: { queryKey: QueryKey }) => T | undefined {
  return (previousData, previousQuery) => {
    if (!previousQuery) return undefined;
    const [prefix, prev, ...prevExtra] = previousQuery.queryKey;
    if (prefix !== queryKeyPrefix || typeof prev !== "string") return undefined;
    if (
      prevExtra.length !== extraKeyParts.length ||
      prevExtra.some((part, i) => !Object.is(part, extraKeyParts[i]))
    )
      return undefined;
    const prevNorm = prev.trim().toLowerCase();
    const nextNorm = query.trim().toLowerCase();
    if (nextNorm.startsWith(prevNorm) || prevNorm.startsWith(nextNorm)) return previousData;
    return undefined;
  };
}
