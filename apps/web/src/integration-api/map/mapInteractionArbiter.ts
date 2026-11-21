import type {
  MapGeoJSONFeature,
  Map as MaplibreMap,
  MapMouseEvent,
  Point,
  Popup,
} from "maplibre-gl";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";

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
  /**
   * Opens what was clicked. Without it the overlay only shows the pointer
   * cursor over its layers, for features another handler opens (basemap-style
   * POIs, for example), and its layers stay out of the interactive registry.
   */
  onClick?: (event: MapOverlayInteractionEvent) => void;
  /**
   * Called on every pointer move with the features under the pointer when this
   * overlay owns the hover, and with `null` when it does not: the pointer is
   * off its layers, a higher-priority overlay owns it, or the pointer left the
   * map. The pointer event comes along while the pointer is over the map.
   */
  onHover?: (features: MapGeoJSONFeature[] | null, event?: MapMouseEvent) => void;
  /**
   * Whether this overlay has content under the point, for content MapLibre
   * cannot query, such as a custom 3D layer. It replaces the rendered-feature
   * lookup, and a hit reports no features.
   */
  hitTest?: (point: Point) => boolean;
}

interface RegistrationRecord extends MapOverlayInteractionRegistration {
  order: number;
}

interface MapInteractionState {
  registrations: Map<string, RegistrationRecord>;
  layerOwners: Map<string, number>;
  arbiterOwnedLayerIds: Set<string>;
  nextOrder: number;
  /** Whether the pointer cursor on the map is the one this arbiter set. */
  ownsCursor: boolean;
  onClick: (event: MapMouseEvent) => void;
  onMouseMove: (event: MapMouseEvent) => void;
  onMouseLeave: (event?: MapMouseEvent) => void;
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

/** The features an overlay has under the pointer, or null when it has none. */
function hitForRegistration(
  map: MaplibreMap,
  registration: RegistrationRecord,
  event: MapMouseEvent,
): MapGeoJSONFeature[] | null {
  if (registration.hitTest) return registration.hitTest(event.point) ? [] : null;
  const layers = existingLayerIds(map, registration.layerIds);
  if (layers.length === 0) return null;
  try {
    const features = map.queryRenderedFeatures(event.point, { layers }) as MapGeoJSONFeature[];
    return features.length > 0 ? features : null;
  } catch {
    // The style may have been torn down during a style swap. A missed hover or
    // click is safer than breaking the map event pipeline in that frame.
    return null;
  }
}

function winningHit(
  map: MaplibreMap,
  state: MapInteractionState,
  event: MapMouseEvent,
  clicksOnly = false,
): { registration: RegistrationRecord; features: MapGeoJSONFeature[] } | null {
  const registrations = [...state.registrations.values()]
    .filter((registration) => !clicksOnly || registration.onClick)
    .sort((a, b) => b.priority - a.priority || a.order - b.order);
  for (const registration of registrations) {
    const features = hitForRegistration(map, registration, event);
    if (features) return { registration, features };
  }
  return null;
}

function reportHover(
  state: MapInteractionState,
  hit: { registration: RegistrationRecord; features: MapGeoJSONFeature[] } | null,
  event?: MapMouseEvent,
): void {
  for (const registration of [...state.registrations.values()]) {
    registration.onHover?.(registration === hit?.registration ? hit.features : null, event);
  }
}

/**
 * Show the pointer over an overlay hit, and take back only a pointer this
 * arbiter set: basemap POIs and the route line keep their own cursor.
 */
function showPointer(map: MaplibreMap, state: MapInteractionState, pointer: boolean): void {
  if (!pointer && !state.ownsCursor) return;
  state.ownsCursor = pointer;
  const style = map.getCanvasContainer().style;
  const cursor = pointer ? "pointer" : "";
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
  state.ownsCursor = false;
  state.onClick = (event) => {
    if (getMapClickOwner(event)) return;
    const hit = winningHit(map, state, event, true);
    hit?.registration.onClick?.({ event, features: hit.features });
  };
  state.onMouseMove = (event) => {
    const hit = winningHit(map, state, event);
    showPointer(map, state, hit !== null);
    reportHover(state, hit, event);
  };
  state.onMouseLeave = (event) => {
    // Moving onto a DOM marker or popup inside the map also fires mouseout, but
    // the pointer is still over the map and the next move reports it again.
    const entered = (event?.originalEvent as MouseEvent | undefined)?.relatedTarget;
    if (entered && map.getCanvasContainer().contains(entered as Node)) return;
    showPointer(map, state, false);
    reportHover(state, null);
  };

  map.on("click", state.onClick);
  map.on("mousemove", state.onMouseMove);
  map.on("mouseout", state.onMouseLeave);
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
  if (registration.onClick) addRegistrationLayers(state, registration.layerIds);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (state.registrations.get(registration.id) !== record) return;
    state.registrations.delete(registration.id);
    if (registration.onClick) removeRegistrationLayers(state, registration.layerIds);
    if (state.registrations.size > 0) return;

    map.off("click", state.onClick);
    map.off("mousemove", state.onMouseMove);
    map.off("mouseout", state.onMouseLeave);
    showPointer(map, state, false);
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
