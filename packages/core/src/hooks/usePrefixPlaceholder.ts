import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * Returns a `placeholderData` function for React Query that keeps previous results
 * only when the new query is a prefix continuation of the old one ("Ful" → "Fuld").
 * Clears immediately when the query is unrelated ("Fulda" → "B").
 */
export function usePrefixPlaceholder<T>(
  queryKeyPrefix: string,
  query: string,
): () => T | undefined {
  const queryClient = useQueryClient();
  const prevQueryRef = useRef(query);

  // Update the ref in an effect (not during render) to avoid side-effects
  // in React's render path that break under Strict Mode double-rendering.
  useEffect(() => {
    prevQueryRef.current = query;
  }, [query]);

  return () => {
    const prev = prevQueryRef.current;
    const prevNorm = prev.trim().toLowerCase();
    const nextNorm = query.trim().toLowerCase();
    if (nextNorm.startsWith(prevNorm) || prevNorm.startsWith(nextNorm)) {
      return queryClient.getQueryData<T>([queryKeyPrefix, prev]);
    }
    return undefined;
  };
}
