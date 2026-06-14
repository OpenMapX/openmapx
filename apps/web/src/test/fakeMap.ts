import type { Map as MaplibreMap } from "maplibre-gl";

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
    handlers: new Map(),
  };

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
    addLayer: (layer: { id: string } & Record<string, unknown>) => {
      state.layers.set(layer.id, layer);
    },
    removeLayer: (id: string) => {
      state.layers.delete(id);
    },
    moveLayer: () => {},
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
    getStyle: () => ({
      layers: [...state.layers.values()],
      sources: Object.fromEntries(state.sources),
    }),
    queryRenderedFeatures: () => [],
    querySourceFeatures: () => [],
    project: (lngLat: unknown) => ({ x: 0, y: 0, lngLat }),
    unproject: () => ({ lng: 0, lat: 0 }),
    getZoom: () => 10,
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBounds: () => ({
      getWest: () => -180,
      getSouth: () => -90,
      getEast: () => 180,
      getNorth: () => 90,
    }),
    getCanvas: () => ({ style: {} }),
    addControl: () => {},
    removeControl: () => {},
    flyTo: () => {},
    easeTo: () => {},
    jumpTo: () => {},
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
