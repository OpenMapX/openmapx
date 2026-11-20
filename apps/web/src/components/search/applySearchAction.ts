import type { AutocompleteResult, CategoryId, LngLat, Place } from "@openmapx/core";
import {
  brandToFilter,
  makeSyntheticStopPlace,
  PANEL,
  resolveStopAsPlace,
  useCategorySearchStore,
  useDataSourceStore,
  usePlaceStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import type { usePlaceEnrichment } from "@/hooks/usePlaceEnrichment";
import type { useMap } from "@/integration-api/map/MapContext";
import {
  launchExploreFromPlace,
  launchExploreTextSearch,
  launchTextSearch,
} from "@/lib/launchExplore";
import { useRecentSearchStore } from "@/stores/recentSearchStore";
import type { StopSearchRequest } from "@/stores/stopSearchStore";
import { findTransitStopPlace, type SearchAction } from "./searchAction";

/** What carrying out a selection needs from the search bar that resolved it. */
export interface SearchActionEffects {
  input: HTMLInputElement | null;
  mapRef: ReturnType<typeof useMap>["mapRef"];
  flyTo: (center: LngLat, zoom?: number) => void;
  selectWithEnrichment: ReturnType<typeof usePlaceEnrichment>["selectWithEnrichment"];
  stopSearch: StopSearchRequest | null;
  finishStopSearch: () => void;
  runRecent: (text: string) => void;
}

/** Carries out what a selection resolved to: the box, the history, the map and the panel. */
export function applySearchAction(action: SearchAction, effects: SearchActionEffects): void {
  const search = useSearchStore.getState();
  const recents = useRecentSearchStore.getState();
  switch (action.kind) {
    case "none":
      return;
    case "pick-stop":
      effects.stopSearch?.onPick({ coordinates: action.coordinates, label: action.label });
      effects.finishStopSearch();
      return;
    case "run-recent":
      effects.runRecent(action.text);
      return;
    case "search-area":
      recents.add(action.text);
      search.setIsFocused(false);
      effects.input?.blur();
      launchTextSearch(effects.mapRef.current, action.text);
      return;
    case "select":
      break;
  }
  if (action.history) {
    recents.add(action.history.search);
    recents.addDestination(action.history.destination);
  }
  const closeWith = (text: string | null) => {
    if (text === null) return;
    search.setQuery(text);
    search.setIsFocused(false);
  };
  const openSidebar = useSidebarStore.getState().openSidebar;
  const categories = useCategorySearchStore.getState();
  const { target } = action;
  switch (target.kind) {
    case "place":
    case "stop":
    case "none":
      closeWith(action.query);
      if (action.query === null) effects.input?.blur();
      break;
  }
  switch (target.kind) {
    case "place":
      if (target.flyTo) effects.flyTo(target.flyTo, 15);
      if (target.transitLookup) {
        const { coordinates, name } = target.transitLookup;
        effects.selectWithEnrichment(target.place, (isCurrent) =>
          findTransitStopPlace(coordinates, name, isCurrent),
        );
      } else {
        usePlaceStore.getState().setSelectedPlace(target.place);
      }
      openSidebar(PANEL.PLACE);
      return;
    case "stop": {
      const { stop } = target;
      if (target.flyTo) effects.flyTo(target.flyTo, 15);
      effects.selectWithEnrichment(makeSyntheticStopPlace(stop), () => resolveStopAsPlace(stop));
      openSidebar(PANEL.PLACE);
      return;
    }
    case "brand":
      categories.setBrandFilter(target.brand, brandToFilter(target.brand));
      openSidebar(PANEL.CATEGORY);
      closeWith(action.query);
      return;
    case "data-source":
      categories.clearCategory();
      useDataSourceStore.getState().setActiveSource(target.sourceId);
      openSidebar(PANEL.DATASOURCE);
      closeWith(action.query);
      return;
    case "category":
      categories.setActiveCategory(target.categoryId);
      openSidebar(PANEL.CATEGORY);
      closeWith(action.query);
      return;
    case "none":
      return;
  }
}

/** A nearby row runs the place-anchored search: its category, or the typed text. */
export function exploreFromNearbyRow(
  row: AutocompleteResult,
  anchor: Place,
  query: string,
  map: maplibregl.Map | null,
): void {
  if (row.id === "nearby-freetext") {
    if (query.length > 0) launchExploreTextSearch(map, anchor, query);
    return;
  }
  const category = row.rawCategory as CategoryId | undefined;
  if (category) launchExploreFromPlace(map, anchor, category, row.label);
}
