import {
  PANEL,
  useDataSourceStore,
  usePlaceStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";

/**
 * Closes the selected place — the card beside a list, or the standalone place
 * panel — the way the card's own close button does.
 */
export function closePlaceSelection(): void {
  usePlaceStore.getState().setSelectedPlace(null);
  useDataSourceStore.getState().clearSelection();
  const sidebar = useSidebarStore.getState();
  if (sidebar.activeDetailId === PANEL.PLACE_CARD) sidebar.closeDetail();
  else if (sidebar.activeSidebarId === PANEL.PLACE) sidebar.closeSidebar();
}

/** Closes the open side panel (list, directions, saved …) and the search it put in the bar. */
export function closeSidebarPanel(): void {
  useSidebarStore.getState().closeSidebar();
  useSearchStore.getState().setQuery("");
}
