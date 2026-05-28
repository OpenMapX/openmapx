import type { CategoryId, Place } from "@openmapx/core";
import {
  bboxAroundPoint,
  PANEL,
  useCategorySearchStore,
  useDataSourceStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import type maplibregl from "maplibre-gl";

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
