import type { Map as MaplibreMap, MissingStyleImageResolver } from "maplibre-gl";

/**
 * A stateful fake MapLibre `Map` for unit-testing map layers and attribution
 * wiring without a real WebGL canvas. Tracks sources/layers/paint/layout and
 * records event handlers so a test can `emit("load")` to fire effects.
 *
 * Promotes the inline fake from `components/map/BaseAttributions.test.tsx` so
 * the ~50 untested `components/map/**` layer files have a shared harness.
 *
 * Unknown methods are not stubbed — add them here (state-backed where it
 * matters) as layer tests need them, rather than silently no-op'ing.
 */
export interface FakeMapState {
  sources: Map<string, Record<string, unknown>>;
  layers: Map<string, Record<string, unknown>>;
  paint: Map<string, Record<string, unknown>>;
  layout: Map<string, Record<string, unknown>>;
  filters: Map<string, unknown>;
  images: Set<string>;
  styleLoaded: boolean;
  /** Backing value for `getZoom()` — mutate then emit("moveend") to simulate a zoom gesture. */
  zoom: number;
  pitch: number;
  maxPitch: number;
  cameraTransitions: Array<{
    method: "easeTo" | "jumpTo";
    options: Record<string, unknown>;
  }>;
  movedLayers: Array<{ layerId: string; beforeId?: string }>;
  light: Record<string, unknown> | null;
  missingStyleImageResolver: MissingStyleImageResolver | null;
  handlers: Map<string, Set<(...args: unknown[]) => void>>;
}

export interface FakeMap {
  /** Cast-ready MapLibre map for code under test. */
  map: MaplibreMap;
  /** Inspect/mutate the recorded map state directly in assertions. */
  state: FakeMapState;
  /** Fire every handler registered for `event` (e.g. emit("load")). */
  emit(event: string, ...args: unknown[]): void;
  /** Attribution strings of all registered sources (what the control shows). */
  registeredAttributions(): string[];
}

export interface CreateFakeMapOptions {
  styleLoaded?: boolean;
  /**
   * The base style's own layers. Restored by `setStyle`, which drops everything
   * else — the app's sources and layers do not survive a style change. Defaults
   * to none so existing tests that assert an exact layer list are unaffected.
   */
  baseLayers?: Array<{ id: string; type: string }>;
  /** Initial `getZoom()` value (default 10). */
  zoom?: number;
  /** Initial camera pitch and pitch constraint. */
  pitch?: number;
  maxPitch?: number;
}

export function createFakeMap(options: CreateFakeMapOptions = {}): FakeMap {
  const state: FakeMapState = {
    sources: new Map(),
    layers: new Map(),
    paint: new Map(),
    layout: new Map(),
    filters: new Map(),
    images: new Set(),
    styleLoaded: options.styleLoaded ?? true,
    zoom: options.zoom ?? 10,
    pitch: options.pitch ?? 0,
    maxPitch: options.maxPitch ?? 60,
    cameraTransitions: [],
    movedLayers: [],
    light: null,
    missingStyleImageResolver: null,
    handlers: new Map(),
  };

  const baseLayers = options.baseLayers ?? [];
  const canvas = { style: { cursor: "" } };
  for (const layer of baseLayers) state.layers.set(layer.id, { ...layer });

  const on = (event: string, ...rest: unknown[]) => {
    // MapLibre overloads: on(type, handler) and on(type, layerId, handler).
    const handler = rest[rest.length - 1] as (...a: unknown[]) => void;
    if (typeof handler !== "function") return api.map;
    if (!state.handlers.has(event)) state.handlers.set(event, new Set());
    state.handlers.get(event)?.add(handler);
    return api.map;
  };
  const off = (event: string, ...rest: unknown[]) => {
    const handler = rest[rest.length - 1] as (...a: unknown[]) => void;
    state.handlers.get(event)?.delete(handler);
    return api.map;
  };

  const fake = {
    isStyleLoaded: () => state.styleLoaded,
    loaded: () => state.styleLoaded,
    getSource: (id: string) => state.sources.get(id),
    addSource: (id: string, source: Record<string, unknown>) => {
      // GeoJSON layer components call `getSource(id).setData(...)` to push new
      // features. The real GeoJSONSource exposes that method, so back it with the
      // recorded `data` field here — otherwise every geojson layer's update
      // effect throws "setData is not a function" the moment it mounts.
      const stored: Record<string, unknown> = { ...source };
      if (source.type === "geojson") {
        stored.setData = (data: unknown) => {
          stored.data = data;
        };
      }
      state.sources.set(id, stored);
    },
    removeSource: (id: string) => {
      state.sources.delete(id);
    },
    getLayer: (id: string) => state.layers.get(id),
    addLayer: (layer: { id: string } & Record<string, unknown>, beforeId?: string) => {
      state.paint.delete(layer.id);
      state.layout.delete(layer.id);
      state.filters.delete(layer.id);
      if (layer.paint && typeof layer.paint === "object") {
        state.paint.set(layer.id, layer.paint as Record<string, unknown>);
      }
      if (layer.layout && typeof layer.layout === "object") {
        state.layout.set(layer.id, layer.layout as Record<string, unknown>);
      }
      if (layer.filter !== undefined) state.filters.set(layer.id, layer.filter);
      if (beforeId === undefined || !state.layers.has(beforeId)) {
        state.layers.set(layer.id, layer);
        return;
      }
      const entries = [...state.layers.entries()].filter(([id]) => id !== layer.id);
      const at = entries.findIndex(([id]) => id === beforeId);
      entries.splice(at, 0, [layer.id, layer]);
      state.layers = new Map(entries);
    },
    removeLayer: (id: string) => {
      state.layers.delete(id);
      state.paint.delete(id);
      state.layout.delete(id);
      state.filters.delete(id);
    },
    moveLayer: (layerId: string, beforeId?: string) => {
      state.movedLayers.push({ layerId, beforeId });
      const existing = state.layers.get(layerId);
      if (!existing) return;
      const entries = [...state.layers.entries()].filter(([id]) => id !== layerId);
      const at = beforeId === undefined ? -1 : entries.findIndex(([id]) => id === beforeId);
      if (at === -1) entries.push([layerId, existing]);
      else entries.splice(at, 0, [layerId, existing]);
      state.layers = new Map(entries);
    },
    setPaintProperty: (layerId: string, name: string, value: unknown) => {
      const m = state.paint.get(layerId) ?? {};
      m[name] = value;
      state.paint.set(layerId, m);
    },
    getPaintProperty: (layerId: string, name: string) => state.paint.get(layerId)?.[name],
    setLayoutProperty: (layerId: string, name: string, value: unknown) => {
      const m = state.layout.get(layerId) ?? {};
      m[name] = value;
      state.layout.set(layerId, m);
    },
    getLayoutProperty: (layerId: string, name: string) => state.layout.get(layerId)?.[name],
    setFilter: (layerId: string, filter: unknown) => {
      state.filters.set(layerId, filter);
    },
    getFilter: (layerId: string) => state.filters.get(layerId),
    setFeatureState: () => {},
    removeFeatureState: () => {},
    hasImage: (id: string) => state.images.has(id),
    addImage: (id: string) => {
      state.images.add(id);
    },
    removeImage: (id: string) => {
      state.images.delete(id);
    },
    setMissingStyleImageResolver: (resolver: MissingStyleImageResolver | null) => {
      state.missingStyleImageResolver = resolver;
      return api.map;
    },
    getStyle: () => ({
      layers: [...state.layers.values()],
      sources: Object.fromEntries(state.sources),
    }),
    /**
     * A style change is a rebuild, not a repaint: MapLibre's `setStyle` drops
     * every source, layer and image the app added, keeping only the incoming
     * style's own layers. `style.load` then fires synchronously, inside this
     * call — that is the diff path MapLibre takes for a style object, and a
     * listener attached after `setStyle` returns misses it entirely. `styledata`
     * follows. Modelling both facts is the point of this method.
     */
    setStyle: (_style?: unknown) => {
      state.layers.clear();
      state.sources.clear();
      state.images.clear();
      state.paint.clear();
      state.layout.clear();
      state.filters.clear();
      for (const layer of baseLayers) state.layers.set(layer.id, { ...layer });
      api.emit("style.load");
      api.emit("styledata");
    },
    queryRenderedFeatures: () => [],
    querySourceFeatures: () => [],
    project: (lngLat: unknown) => ({ x: 0, y: 0, lngLat }),
    unproject: () => ({ lng: 0, lat: 0 }),
    getZoom: () => state.zoom,
    getPitch: () => state.pitch,
    getMaxPitch: () => state.maxPitch,
    setMaxPitch: (maxPitch: number) => {
      state.maxPitch = maxPitch;
    },
    setLight: (light: Record<string, unknown>) => {
      state.light = light;
    },
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBounds: () => ({
      getWest: () => -180,
      getSouth: () => -90,
      getEast: () => 180,
      getNorth: () => 90,
    }),
    getCanvas: () => canvas,
    getCanvasContainer: () => canvas,
    addControl: () => {},
    removeControl: () => {},
    flyTo: () => {},
    easeTo: (options: Record<string, unknown>) => {
      state.cameraTransitions.push({ method: "easeTo", options });
      if (typeof options.pitch === "number") state.pitch = options.pitch;
    },
    jumpTo: (options: Record<string, unknown>) => {
      state.cameraTransitions.push({ method: "jumpTo", options });
      if (typeof options.pitch === "number") state.pitch = options.pitch;
    },
    fitBounds: () => {},
    on,
    off,
    once: on,
  };

  const api: FakeMap = {
    map: fake as unknown as MaplibreMap,
    state,
    emit(event, ...args) {
      for (const handler of state.handlers.get(event) ?? []) handler(...args);
    },
    registeredAttributions() {
      return [...state.sources.values()].map((s) => (s.attribution as string | undefined) ?? "");
    },
  };
  return api;
}
