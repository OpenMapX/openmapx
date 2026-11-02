import {
  PANEL,
  type Place,
  useDirectionsStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { buildLocationShareUrl, type ShareCurrentUrlResult, shareUrl } from "@/lib/deepLink";

/**
 * Actions on an arbitrary map location, shared by the desktop context menu and
 * the dropped-pin card so both treat a point on the map the same way.
 */

/** Starts or ends a route at the location and shows the directions panel. */
export function routeFromOrTo(
  endpoint: "origin" | "destination",
  coordinates: [number, number],
  label: string,
): void {
  const directions = useDirectionsStore.getState();
  const index = endpoint === "origin" ? 0 : directions.waypoints.length - 1;
  directions.setWaypoint(index, coordinates, label);
  directions.open();
  useSidebarStore.getState().closeDetail();
  useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
}

/** Opens the location as a place: its own panel, or a card beside the open list. */
export function openLocationDetails(place: Place): void {
  usePlaceStore.getState().setSelectedPlace(place);
  const sidebar = useSidebarStore.getState();
  if (!sidebar.activeSidebarId || sidebar.activeSidebarId === PANEL.PLACE) {
    sidebar.closeDetail();
    sidebar.openSidebar(PANEL.PLACE);
  } else {
    sidebar.openDetail(PANEL.PLACE_CARD);
  }
}

/** Shares a link that opens the location as a place. */
export function shareLocationLink(place: Place): Promise<ShareCurrentUrlResult> {
  const url = buildLocationShareUrl(window.location.href, {
    id: place.id,
    coordinates: place.coordinates,
    name: place.name,
    category: place.category,
    rawCategory: place.rawCategory,
  });
  return shareUrl({ url, title: place.name });
}
