import type { AutocompleteResult, LngLat } from "@openmapx/core";
import { useCategorySearchStore, useSearchStore } from "@openmapx/core";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { useMap } from "@/integration-api/map/MapContext";
import { useStopSearchStore } from "@/stores/stopSearchStore";

/**
 * Collapses the search a moment after focus leaves it, so a click on a
 * suggestion lands first. Focus coming back within the delay cancels it.
 */
export function useDelayedBlur(onBlurStart: () => void) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBlur = useCallback(() => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);
  useEffect(() => cancelBlur, [cancelBlur]);
  const handleBlur = useCallback(() => {
    onBlurStart();
    cancelBlur();
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      useSearchStore.getState().setIsFocused(false);
    }, 150);
  }, [onBlurStart, cancelBlur]);
  return { cancelBlur, handleBlur };
}

/**
 * Submits the search form once new text has flushed into the query: voice
 * dictation and recent-search rows fill the input and then run through the
 * normal submit path, so they behave exactly like typing and Enter.
 */
export function useSubmitAfterFlush(inputRef: RefObject<HTMLInputElement | null>) {
  const [submitAfterFlush, setSubmitAfterFlush] = useState(false);
  // Deferred to an effect so the query state has updated before
  // `requestSubmit` reads it.
  useEffect(() => {
    if (!submitAfterFlush) return;
    setSubmitAfterFlush(false);
    inputRef.current?.form?.requestSubmit();
  }, [submitAfterFlush, inputRef]);
  return useCallback(() => setSubmitAfterFlush(true), []);
}

/**
 * Phone directions borrow the search to choose a trip stop. A stop search
 * starts from the stop's text in the full-screen search, and ends whenever
 * that search closes, however it is left.
 */
export function useStopSearchSession(inputRef: RefObject<HTMLInputElement | null>) {
  const stopSearch = useStopSearchStore((s) => s.request);
  const isFocused = useSearchStore((s) => s.isFocused);
  const shownRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once per request
  useEffect(() => {
    shownRef.current = false;
    if (!stopSearch) return;
    const search = useSearchStore.getState();
    search.setQuery(stopSearch.initialQuery);
    search.setIsFocused(true);
    inputRef.current?.focus();
  }, [stopSearch]);
  useEffect(() => {
    if (!stopSearch) return;
    if (isFocused) shownRef.current = true;
    else if (shownRef.current) useStopSearchStore.getState().close();
  }, [stopSearch, isFocused]);

  const finish = useCallback(() => {
    const search = useSearchStore.getState();
    search.setQuery("");
    search.setIsFocused(false);
    useStopSearchStore.getState().close();
  }, []);
  return { stopSearch, finish };
}

/**
 * The place a nearby search is anchored to. Entering nearby mode (Nearby on
 * a place) clears the query and focuses the bar, so the category picker
 * opens in the reused search bar.
 */
export function useNearbyAnchor(inputRef: RefObject<HTMLInputElement | null>) {
  const anchor = useCategorySearchStore((s) => s.anchor);
  const exploreBoxOpen = useCategorySearchStore((s) => s.exploreBoxOpen);
  useEffect(() => {
    if (!exploreBoxOpen) return;
    const search = useSearchStore.getState();
    search.setQuery("");
    search.setIsFocused(true);
    inputRef.current?.focus();
  }, [exploreBoxOpen, inputRef]);
  return anchor;
}

/**
 * Snapshot of the viewport, read from the map on each render (cheap ref
 * reads). Suggestions are biased towards it and ranked by distance from it;
 * the hooks round it, so small pans reuse cached answers.
 */
export function useViewportSnapshot(mapRef: ReturnType<typeof useMap>["mapRef"]) {
  const center = mapRef.current?.getCenter();
  const lng = center?.lng;
  const lat = center?.lat;
  const mapCenter = useMemo<LngLat | null>(
    () => (lng !== undefined && lat !== undefined ? [lng, lat] : null),
    [lng, lat],
  );
  return { mapCenter, mapZoom: mapRef.current?.getZoom() };
}

/** Rows are keyed by type and id together: a category and a place can share an id. */
function rowKey(row: AutocompleteResult): string {
  return `${row.type}:${row.id}`;
}

interface SuggestionKeyboardInput {
  rows: readonly AutocompleteResult[];
  /** Whether the list is showing. */
  open: boolean;
  /** Whether the arrow keys may bring a closed list back. */
  canReopen: boolean;
  isComposing: () => boolean;
  onEscape: () => void;
  onReopen: () => void;
  onChoose: (row: AutocompleteResult) => void;
}

/**
 * Arrow-key highlighting over the suggestion rows, Enter on the highlighted
 * row and Escape. The highlight is keyed by row rather than position, so rows
 * arriving late cannot slide a different place under it.
 */
export function useSuggestionKeyboard({
  rows,
  open,
  canReopen,
  isComposing,
  onEscape,
  onReopen,
  onChoose,
}: SuggestionKeyboardInput) {
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const highlightedIndex =
    highlightedKey === null ? -1 : rows.findIndex((row) => rowKey(row) === highlightedKey);
  const highlightRow = (row: AutocompleteResult | undefined | null) =>
    setHighlightedKey(row ? rowKey(row) : null);
  const highlightAt = (index: number) => highlightRow(rows[index]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || isComposing()) return;
    if (e.key === "Escape") {
      onEscape();
      setHighlightedKey(null);
      return;
    }
    const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
    if (!open) {
      // Escape closed the list without leaving the input; the arrow keys bring it back.
      if (arrow && canReopen) {
        e.preventDefault();
        onReopen();
      }
      return;
    }
    const last = rows.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightAt(highlightedIndex < last ? highlightedIndex + 1 : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightAt(highlightedIndex > 0 ? highlightedIndex - 1 : last);
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      const row = rows[highlightedIndex];
      if (row) onChoose(row);
    }
  };

  return { highlightedIndex, highlightAt, highlightRow, handleKeyDown };
}
