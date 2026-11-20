import type { AutocompleteResult, BoundingBox, LngLat, Place, SearchResult } from "@openmapx/core";
import { useSearchStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import type { RefObject } from "react";
import { launchExploreTextSearch, launchTextSearch } from "@/lib/launchExplore";
import { useRecentSearchStore } from "@/stores/recentSearchStore";
import { resolveGeocodeAction, type SearchAction } from "./searchAction";
import { decideSearchSubmission, type NlpSubmissionContext } from "./searchSubmission";

/** What Enter in the search box acts on, captured at the render it happened in. */
export interface SearchEnterContext {
  /** The text as typed. */
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
  mapRef: RefObject<maplibregl.Map | null>;
  /** Whether phone directions borrowed the search to choose a stop. */
  stopSearch: boolean;
  /** The place a nearby search is anchored to. */
  anchor: Place | null;
  rows: readonly AutocompleteResult[];
  rankedSuggestions: readonly AutocompleteResult[];
  /** A row the typed text names outright, such as coordinates. */
  syntheticResult: AutocompleteResult | null;
  /** Whether the rows answer exactly the typed text. */
  settled: boolean;
  mapCenter: LngLat | null;
  mapZoom: number | undefined;
  geocodeQuery: string;
  geocodeResults: readonly SearchResult[] | undefined;
  beginSubmission: () => NlpSubmissionContext;
  deferSubmission: (context: NlpSubmissionContext) => void;
  runSubmission: (context: NlpSubmissionContext) => void;
  startNlp: (context: NlpSubmissionContext) => boolean;
  select: (row: AutocompleteResult, recordHistory?: boolean) => void;
  apply: (action: SearchAction) => void;
  /** Opens the list with a row highlighted for the person to confirm. */
  chooseRow: (row: AutocompleteResult | undefined) => void;
}

/** Plain Enter on non-empty text, before the rows for it are trusted. */
export function submitSearch(ctx: SearchEnterContext): void {
  const q = ctx.query.trim();
  if (!q) return;
  if (ctx.stopSearch) {
    const first = ctx.rows[0];
    if (first) ctx.select(first);
    return;
  }
  const nlpContext = ctx.beginSubmission();
  if (ctx.anchor) {
    ctx.inputRef.current?.blur();
    launchExploreTextSearch(ctx.mapRef.current, ctx.anchor, q);
    return;
  }
  if (ctx.syntheticResult) {
    useRecentSearchStore.getState().add(q);
    ctx.inputRef.current?.blur();
    ctx.select(ctx.syntheticResult, false);
    return;
  }
  // Act on the suggestions for exactly this text: wait for them to arrive
  // rather than choosing from rows that belong to an earlier keystroke.
  if (!ctx.settled) {
    ctx.deferSubmission(nlpContext);
    return;
  }
  ctx.runSubmission(nlpContext);
}

/** Enter once the rows answer the typed text: open, choose, parse or search the area. */
export function finishSubmit(nlpContext: NlpSubmissionContext, ctx: SearchEnterContext): void {
  const q = ctx.query.trim();
  useRecentSearchStore.getState().add(q);
  const action = decideSearchSubmission({
    query: ctx.query,
    rankedSuggestions: ctx.rankedSuggestions,
    proximity: ctx.mapCenter ?? undefined,
    zoom: ctx.mapZoom,
    geocodeQuery: ctx.geocodeQuery,
    geocodeResults: ctx.geocodeResults,
  });
  switch (action.kind) {
    case "open-row":
      ctx.inputRef.current?.blur();
      ctx.select(action.row, false);
      return;
    case "choose-row":
      ctx.chooseRow(action.row);
      return;
    case "open-geocode":
      ctx.apply(resolveGeocodeAction(action.result, action.address, action.isTransit));
      return;
    case "search":
      break;
  }
  // Not a confident place match → run the NL parse and keep the dropdown open
  // (place candidates + AI card) so the user disambiguates. Never auto-navigate
  // to a low-relevance geocode result. A parse with nothing to offer falls
  // back to the search of the visible area through the submission controller.
  if (ctx.startNlp(nlpContext)) return;
  // Without the AI parse, Enter searches the visible area for the text.
  useSearchStore.getState().setIsFocused(false);
  ctx.inputRef.current?.blur();
  launchTextSearch(ctx.mapRef.current, q);
}

/** The viewport an explicit submission is anchored to, read from the map at that moment. */
export function captureViewport(map: maplibregl.Map | null): {
  mapCenter: LngLat | null;
  mapBbox: BoundingBox | null;
} {
  const center = map?.getCenter();
  const bounds = map?.getBounds();
  return {
    mapCenter: center ? [center.lng, center.lat] : null,
    mapBbox: bounds
      ? {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        }
      : null,
  };
}
