import type { MapGeoJSONFeature, Map as MaplibreMap, MapMouseEvent, Popup } from "maplibre-gl";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";

export interface MapOverlayInteractionEvent {
  event: MapMouseEvent;
  features: MapGeoJSONFeature[];
}

export interface MapOverlayInteractionRegistration {
  /** Stable owner id, used to unregister exactly one overlay. */
  id: string;
  /** MapLibre layers owned by this overlay, in its preferred hit-test order. */
  layerIds: readonly string[];
  /** Larger values win when several registered overlays have a rendered hit. */
  priority: number;
  onClick: (event: MapOverlayInteractionEvent) => void;
}

interface RegistrationRecord extends MapOverlayInteractionRegistration {
  order: number;
}

interface MapInteractionState {
  registrations: Map<string, RegistrationRecord>;
  layerOwners: Map<string, number>;
  arbiterOwnedLayerIds: Set<string>;
  nextOrder: number;
  onClick: (event: MapMouseEvent) => void;
  onMouseMove: (event: MapMouseEvent) => void;
  onMouseLeave: () => void;
}

const mapStates = new WeakMap<MaplibreMap, MapInteractionState>();
const activePopups = new WeakMap<MaplibreMap, Popup>();

function existingLayerIds(map: MaplibreMap, layerIds: readonly string[]): string[] {
  return layerIds.filter((id) => {
    try {
      return !!map.getLayer(id);
    } catch {
      // A style can be replaced between getLayer and queryRenderedFeatures.
      return false;
    }
  });
}

function hitForRegistration(
  map: MaplibreMap,
  registration: RegistrationRecord,
  event: MapMouseEvent,
): MapGeoJSONFeature[] {
  const layers = existingLayerIds(map, registration.layerIds);
  if (layers.length === 0) return [];
  try {
    return map.queryRenderedFeatures(event.point, { layers }) as MapGeoJSONFeature[];
  } catch {
    // The style may have been torn down during a style swap. A missed hover or
    // click is safer than breaking the map event pipeline in that frame.
    return [];
  }
}

function winningHit(
  map: MaplibreMap,
  state: MapInteractionState,
  event: MapMouseEvent,
): { registration: RegistrationRecord; features: MapGeoJSONFeature[] } | null {
  const registrations = [...state.registrations.values()].sort(
    (a, b) => b.priority - a.priority || a.order - b.order,
  );
  for (const registration of registrations) {
    const features = hitForRegistration(map, registration, event);
    if (features.length > 0) return { registration, features };
  }
  return null;
}

function setCursor(map: MaplibreMap, cursor: string): void {
  const style = map.getCanvasContainer().style;
  if (style.cursor !== cursor) style.cursor = cursor;
}

function addRegistrationLayers(state: MapInteractionState, layerIds: readonly string[]): void {
  for (const id of new Set(layerIds)) {
    const owners = state.layerOwners.get(id) ?? 0;
    state.layerOwners.set(id, owners + 1);
    if (owners === 0 && !INTERACTIVE_LAYER_IDS.has(id)) {
      INTERACTIVE_LAYER_IDS.add(id);
      state.arbiterOwnedLayerIds.add(id);
    }
  }
}

function removeRegistrationLayers(state: MapInteractionState, layerIds: readonly string[]): void {
  for (const id of new Set(layerIds)) {
    const owners = state.layerOwners.get(id) ?? 0;
    if (owners <= 1) {
      state.layerOwners.delete(id);
      if (state.arbiterOwnedLayerIds.delete(id)) INTERACTIVE_LAYER_IDS.delete(id);
    } else {
      state.layerOwners.set(id, owners - 1);
    }
  }
}

function createMapState(map: MaplibreMap): MapInteractionState {
  const state = {} as MapInteractionState;
  state.registrations = new Map();
  state.layerOwners = new Map();
  state.arbiterOwnedLayerIds = new Set();
  state.nextOrder = 0;
  state.onClick = (event) => {
    const hit = winningHit(map, state, event);
    if (!hit) return;
    hit.registration.onClick({ event, features: hit.features });
  };
  state.onMouseMove = (event) => {
    setCursor(map, winningHit(map, state, event) ? "pointer" : "");
  };
  state.onMouseLeave = () => setCursor(map, "");

  map.on("click", state.onClick);
  map.on("mousemove", state.onMouseMove);
  map.on("mouseleave", state.onMouseLeave);
  mapStates.set(map, state);
  return state;
}

/**
 * Register one overlay's hit-test ownership on a map. All registrations on a
 * map share one click and one hover pipeline, so overlapping overlays cannot
 * replace each other's popup or cursor state.
 */
export function registerMapOverlayInteraction(
  map: MaplibreMap,
  registration: MapOverlayInteractionRegistration,
): () => void {
  const state = mapStates.get(map) ?? createMapState(map);
  const record: RegistrationRecord = { ...registration, order: state.nextOrder++ };
  state.registrations.set(registration.id, record);
  addRegistrationLayers(state, registration.layerIds);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (state.registrations.get(registration.id) !== record) return;
    state.registrations.delete(registration.id);
    removeRegistrationLayers(state, registration.layerIds);
    if (state.registrations.size > 0) return;

    map.off("click", state.onClick);
    map.off("mousemove", state.onMouseMove);
    map.off("mouseleave", state.onMouseLeave);
    setCursor(map, "");
    mapStates.delete(map);
  };
}

/** Replace the one popup owned by overlay interactions on this map. */
export function replaceMapOverlayPopup(map: MaplibreMap, popup: Popup): void {
  const previous = activePopups.get(map);
  if (previous && previous !== popup) previous.remove();
  activePopups.set(map, popup);
  popup.addTo(map);
}

/** Remove a popup only if it is still the current popup for this map. */
export function removeMapOverlayPopup(map: MaplibreMap, popup: Popup): void {
  if (activePopups.get(map) !== popup) return;
  activePopups.delete(map);
  popup.remove();
}
