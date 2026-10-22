import type { AutocompleteResult, BoundingBox, LngLat, SearchResult } from "@openmapx/core";
import { enterAction, isPlausibleDestination, isTransitRawCategory } from "@openmapx/core";
import { isConfidentPlaceMatch, typedAddressIn } from "@/lib/placeMatch";

export type SearchBarSurface = "map" | "street-level";

/** Explicit submission owns this snapshot even while suggestions or consent settle. */
export type NlpSubmissionContext = Readonly<{
  query: string;
  aiSearchEnabled: boolean;
  selectionRevision: number;
  mapCenter: LngLat | null;
  mapBbox: BoundingBox | null;
}>;

type SubmissionDecision =
  | { kind: "open-row"; row: AutocompleteResult }
  | { kind: "choose-row"; row: AutocompleteResult | undefined }
  | { kind: "open-geocode"; result: SearchResult; address: string | undefined; isTransit: boolean }
  | { kind: "search" };

/** Resolve plain Enter without applying selection, map or NLP effects. Ranking stays authoritative. */
export function decideSearchSubmission({
  query,
  rankedSuggestions,
  proximity,
  zoom,
  geocodeQuery,
  geocodeResults,
}: {
  query: string;
  rankedSuggestions: readonly AutocompleteResult[];
  proximity: LngLat | undefined;
  zoom: number | undefined;
  geocodeQuery: string;
  geocodeResults: readonly SearchResult[] | undefined;
}): SubmissionDecision {
  const context = { query: query.trim(), proximity, zoom };
  const action = enterAction(rankedSuggestions, context);
  if (action.kind === "open") return { kind: "open-row", row: action.row };
  if (action.kind === "choose") return { kind: "choose-row", row: rankedSuggestions[0] };
  const first = action.weak && geocodeQuery === query ? geocodeResults?.[0] : undefined;
  if (first) {
    const isTransit = Boolean(first.rawCategory && isTransitRawCategory(first.rawCategory));
    const address = typedAddressIn(query, first.label);
    const isPreciseType = first.type !== "poi" || isTransit || address !== undefined;
    const asRow = {
      id: first.id,
      label: first.label,
      coordinates: first.coordinates,
      type: first.type,
      rawCategory: first.rawCategory,
    };
    if (
      isPreciseType &&
      isConfidentPlaceMatch(query.trim(), first) &&
      isPlausibleDestination(asRow, context)
    ) {
      // Keep the original record: selection needs source receipts and field provenance.
      return { kind: "open-geocode", result: first, address, isTransit };
    }
  }
  return { kind: "search" };
}
