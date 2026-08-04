import type { CategoryId, Place } from "@openmapx/core";
import {
  bboxAroundPoint,
  PANEL,
  useCategorySearchStore,
  useDataSourceStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";

const FRAME_RADIUS_METRES = 1000;

/**
 * Launch a category search anchored on a place: frame the map on the place,
 * then activate the existing category-search pipeline.
 */
export function launchExploreFromPlace(
  map: maplibregl.Map | null,
  anchor: Place,
  category: CategoryId,
  label: string,
): void {
  const store = useCategorySearchStore.getState();
  const bbox = bboxAroundPoint(anchor.coordinates, FRAME_RADIUS_METRES);

  if (map) {
    map.fitBounds(
      [
        [bbox.west, bbox.south],
        [bbox.east, bbox.north],
      ],
      { padding: 80, duration: 0 },
      { programmatic: true },
    );
  }

  useDataSourceStore.getState().setActiveSource(null);
  store.setAnchor(anchor);
  store.setSearchBbox(bbox);
  store.setMapMoved(false);
  store.setActiveCategory(category);
  store.closeExploreBox();
  useSearchStore.getState().setQuery(label);
  useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
}

/**
 * Launch a free-text search anchored on a place: frame the map on the place,
 * then run the proximity-biased geocode via text mode.
 */
export function launchExploreTextSearch(
  map: maplibregl.Map | null,
  anchor: Place,
  query: string,
): void {
  const trimmed = query.trim();
  if (trimmed.length === 0) return;
  const store = useCategorySearchStore.getState();
  const bbox = bboxAroundPoint(anchor.coordinates, FRAME_RADIUS_METRES);

  if (map) {
    map.fitBounds(
      [
        [bbox.west, bbox.south],
        [bbox.east, bbox.north],
      ],
      { padding: 80, duration: 0 },
      { programmatic: true },
    );
  }

  useDataSourceStore.getState().setActiveSource(null);
  store.setAnchor(anchor);
  store.setSearchBbox(bbox);
  store.setMapMoved(false);
  store.setExploreText(trimmed);
  store.closeExploreBox();
  useSearchStore.getState().setQuery(trimmed);
  useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
}

/**
 * Launch a free-text POI search over the current map viewport (not anchored to
 * a place): snapshot the current bounds as the search bbox and run text mode.
 * Used when the user submits the top search bar. Panning the map then offers
 * "search this area" (see CategoryResultsContent).
 */
export function launchTextSearch(map: maplibregl.Map | null, query: string): void {
  const trimmed = query.trim();
  if (trimmed.length === 0 || !map) return;
  const store = useCategorySearchStore.getState();
  const b = map.getBounds();

  useDataSourceStore.getState().setActiveSource(null);
  store.setAnchor(null);
  store.setSearchBbox({
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  });
  store.setMapMoved(false);
  store.setExploreText(trimmed);
  store.closeExploreBox();
  useSearchStore.getState().setQuery(trimmed);
  useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
}
