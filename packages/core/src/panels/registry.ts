import { useCategorySearchStore } from "../stores/categorySearchStore";
import { useDataSourceStore } from "../stores/dataSourceStore";
import { useDirectionsStore } from "../stores/directionsStore";
import { usePersonalTimelineStore } from "../stores/personalTimelineStore";
import { usePlaceStore } from "../stores/placeStore";
import { useSavedPlacesStore } from "../stores/savedPlacesStore";
import { PANEL } from "./ids";
import type { PanelDefinition, PanelLayer } from "./types";

export const PANEL_REGISTRY: Record<string, PanelDefinition> = {
  [PANEL.PLACE]: {
    id: PANEL.PLACE,
    layer: "sidebar",
    onDeactivate: () => usePlaceStore.getState().setSelectedPlace(null),
  },
  [PANEL.CATEGORY]: {
    id: PANEL.CATEGORY,
    layer: "sidebar",
    onDeactivate: () => useCategorySearchStore.getState().clearCategory(),
  },
  [PANEL.DATASOURCE]: {
    id: PANEL.DATASOURCE,
    layer: "sidebar",
    onDeactivate: () => useDataSourceStore.getState().setActiveSource(null),
  },
  [PANEL.DIRECTIONS]: {
    id: PANEL.DIRECTIONS,
    layer: "sidebar",
    onDeactivate: () => useDirectionsStore.getState().close(),
  },
  [PANEL.SAVED]: {
    id: PANEL.SAVED,
    layer: "sidebar",
    onDeactivate: () => useSavedPlacesStore.getState().clearSelectedList(),
  },
  [PANEL.TIMELINE]: {
    id: PANEL.TIMELINE,
    layer: "sidebar",
    onDeactivate: () => usePersonalTimelineStore.getState().clearPanelSelection(),
  },
  [PANEL.PLACE_CARD]: {
    id: PANEL.PLACE_CARD,
    layer: "detail",
  },
};

export function getPanel(id: string): PanelDefinition | undefined {
  return PANEL_REGISTRY[id];
}

export function getPanelsByLayer(layer: PanelLayer): PanelDefinition[] {
  return Object.values(PANEL_REGISTRY).filter((p) => p.layer === layer);
}
