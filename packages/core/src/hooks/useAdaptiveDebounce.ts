import { useEffect, useRef, useState } from "react";

/**
 * Debounce that adapts its delay based on whether the user is continuing
 * to type within the same "word" (prefix extension) or starting fresh.
 *
 * - Cold start ("" → "Ha"): uses `initialDelay` (longer, avoids wasted calls)
 * - Prefix continuation ("Ham" → "Hamb"): uses `continuationDelay` (shorter,
 *   results already visible via client-side filtering)
 *
 * This lets the first API call fire quickly while subsequent refinements
 * arrive even faster — without increasing total API load significantly
 * because the debounce is still in place.
 */
export function useAdaptiveDebounce(
  value: string,
  initialDelay: number,
  continuationDelay: number,
): string {
  const [debounced, setDebounced] = useState(value);
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    const prev = lastEmittedRef.current.trim().toLowerCase();
    const next = value.trim().toLowerCase();
    const isContinuation = prev.length > 0 && next.startsWith(prev);
    const delay = isContinuation ? continuationDelay : initialDelay;

    const timer = setTimeout(() => {
      setDebounced(value);
      lastEmittedRef.current = value;
    }, delay);
    return () => clearTimeout(timer);
  }, [value, initialDelay, continuationDelay]);

  return debounced;
}
