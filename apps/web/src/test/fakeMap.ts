import type { MapGeoJSONFeature, Map as MaplibreMap, MissingStyleImageResolver } from "maplibre-gl";

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
  renderedFeatures: Map<string, MapGeoJSONFeature[]>;
  canvas: HTMLCanvasElement;
  projectedPoint: { x: number; y: number };
  sources: Map<string, Record<string, unknown>>;
  layers: Map<string, Record<string, unknown>>;
  paint: Map<string, Record<string, unknown>>;
  layout: Map<string, Record<string, unknown>>;
  filters: Map<string, unknown>;
  images: Set<string>;
  styleLoaded: boolean;
  /**
   * Cumulative operation counts, for tests asserting a hot path did (or did
   * not) call the map. These are test instrumentation, not map state: unlike
   * every other field above, `setStyle` does NOT reset them, so a test can
   * prove something survived a style rebuild without being re-created (e.g.
   * "a layer was never removed and re-added across many updates"). A test
   * that wants a fresh window can snapshot the counts before an action and
   * subtract after.
   */
  counts: {
    setData: Map<string, number>;
    setPaintProperty: Map<string, number>;
    /** Keyed by `${layerId}:${propertyName}`, e.g. to isolate `line-gradient` updates. */
    setPaintPropertyByName: Map<string, number>;
    setFilter: Map<string, number>;
    addLayer: Map<string, number>;
    removeLayer: Map<string, number>;
  };
  /** Backing value for `getZoom()` — mutate then emit("moveend") to simulate a zoom gesture. */
  zoom: number;
  pitch: number;
  maxPitch: number;
  /** Backing value for `getBearing()`. */
  bearing: number;
  /** Backing value for `getCenter()`; `jumpTo`/`easeTo` write it when they carry a centre. */
  center: { lng: number; lat: number };
  /** Backing value for `getPadding()`; null until a transition carries padding. */
  padding: { top: number; bottom: number; left: number; right: number } | null;
  cameraTransitions: Array<{
    method: "easeTo" | "jumpTo" | "flyTo" | "fitBounds" | "setPadding";
    options: Record<string, unknown>;
    /** Second argument, e.g. `{ programmatic: true }`; undefined when omitted. */
    eventData?: Record<string, unknown>;
  }>;
  cameraForBoundsCalls: Array<{ bounds: unknown; options: Record<string, unknown> | undefined }>;
  /** Backing value for `isMoving()` — set it to stage a camera animation in flight. */
  moving: boolean;
  movedLayers: Array<{ layerId: string; beforeId?: string }>;
  light: Record<string, unknown> | null;
  missingStyleImageResolver: MissingStyleImageResolver | null;
  handlers: Map<string, Set<(...args: unknown[]) => void>>;
  /** Every registered or removed map listener, preserving overload arguments and handler identity. */
  listenerCalls: Array<{
    method: "on" | "off";
    event: string;
    layerId?: string;
    handler: (...args: unknown[]) => void;
  }>;
}

export interface FakeMap {
  /** Cast-ready MapLibre map for code under test. */
  map: MaplibreMap;
  /** Inspect/mutate the recorded map state directly in assertions. */
  state: FakeMapState;
  /** Fire every handler registered for `event` (e.g. emit("load")). */
  emit(event: string, ...args: unknown[]): void;
  setRenderedFeatures(layerId: string, features: MapGeoJSONFeature[]): void;
  /** Attribution strings of all registered sources (what the control shows). */
  registeredAttributions(): string[];
  /**
   * Ends the animated transition in flight: lands its camera and, under
   * `emitCameraEvents`, fires the `moveend` that closes it. Only an animation
   * held back by `deferAnimatedCamera` has anything to land.
   */
  settleCameraAnimation(): void;
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
  /** Initial `getBearing()` value (default 0). */
  bearing?: number;
  /** Initial `getCenter()` value (default null island). */
  center?: { lng: number; lat: number };
  /** `getContainer().clientHeight`, which camera padding maths read (default 800). */
  containerHeight?: number;
  /** `getContainer().clientWidth` (default 1200). */
  containerWidth?: number;
  /** Screen projection used by `project()`; defaults to the fixed `projectedPoint`. */
  project?: (lngLat: [number, number]) => { x: number; y: number };
  /** Initial WGS84 viewport bounds, including wrapped west > east antimeridian views. */
  bounds?: { west: number; south: number; east: number; north: number };
  /**
   * Reproduce MapLibre's synchronous move-event ordering for the camera
   * methods: every one of them stops the running animation first — firing that
   * animation's `moveend` with the event data it was started with — and instant
   * moves then fire `movestart`/`moveend` back to back. Off by default, since
   * most consumers only read `cameraTransitions` and would see new events.
   */
  emitCameraEvents?: boolean;
  /**
   * Hold an animated transition's camera back until the animation ends, the
   * way `easeTo`/`flyTo` reach their target over a duration rather than the
   * instant the call returns. `settleCameraAnimation()` lands it; another
   * camera call stops it where it stood. Off by default, since most consumers
   * read the camera back straight after asking for it.
   */
  deferAnimatedCamera?: boolean;
}

export function createFakeMap(options: CreateFakeMapOptions = {}): FakeMap {
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  const state: FakeMapState = {
    renderedFeatures: new Map(),
    canvas,
    projectedPoint: { x: 0, y: 0 },
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
    bearing: options.bearing ?? 0,
    center: options.center ?? { lng: 0, lat: 0 },
    padding: null,
    cameraTransitions: [],
    cameraForBoundsCalls: [],
    moving: false,
    movedLayers: [],
    light: null,
    missingStyleImageResolver: null,
    handlers: new Map(),
    listenerCalls: [],
    counts: {
      setData: new Map(),
      setPaintProperty: new Map(),
      setPaintPropertyByName: new Map(),
      setFilter: new Map(),
      addLayer: new Map(),
      removeLayer: new Map(),
    },
  };

  const bump = (counts: Map<string, number>, key: string) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  const baseLayers = options.baseLayers ?? [];
  const container = {
    clientHeight: options.containerHeight ?? 800,
    clientWidth: options.containerWidth ?? 1200,
  };
  for (const layer of baseLayers) state.layers.set(layer.id, { ...layer });

  const emitCameraEvents = options.emitCameraEvents ?? false;
  const deferAnimatedCamera = options.deferAnimatedCamera ?? false;
  let animating: {
    eventData?: Record<string, unknown>;
    options: Record<string, unknown>;
  } | null = null;

  const stopAnimation = () => {
    if (!animating) return;
    const { eventData } = animating;
    animating = null;
    // The camera stays where the stopped animation left it, which under
    // `deferAnimatedCamera` is where it started.
    if (emitCameraEvents) api.emit("moveend", eventData ?? {});
  };
  const startMove = (
    eventData: Record<string, unknown> | undefined,
    animated: boolean,
    cameraOptions: Record<string, unknown>,
  ) => {
    if (animated && (emitCameraEvents || deferAnimatedCamera)) {
      animating = { eventData, options: cameraOptions };
    }
    if (!emitCameraEvents) return;
    api.emit("movestart", eventData ?? {});
    if (!animated) api.emit("moveend", eventData ?? {});
  };

  // Camera transitions move the state a caller can read back. Centre, pitch and
  // padding follow the transition; zoom and bearing stay test-driven inputs,
  // since tests set `state.zoom` by hand to stage a gesture and then assert on
  // what the code under test did with it.
  const applyCamera = (options: Record<string, unknown>) => {
    if (typeof options.pitch === "number") state.pitch = options.pitch;
    const center = options.center;
    if (Array.isArray(center) && typeof center[0] === "number" && typeof center[1] === "number") {
      state.center = { lng: center[0], lat: center[1] };
    } else if (center && typeof center === "object") {
      const { lng, lat } = center as { lng?: number; lat?: number };
      if (typeof lng === "number" && typeof lat === "number") state.center = { lng, lat };
    }
    const padding = options.padding;
    if (padding && typeof padding === "object") {
      const p = padding as Record<string, number>;
      state.padding = {
        top: p.top ?? 0,
        bottom: p.bottom ?? 0,
        left: p.left ?? 0,
        right: p.right ?? 0,
      };
    }
  };

  const on = (event: string, ...rest: unknown[]) => {
    // MapLibre overloads: on(type, handler) and on(type, layerId, handler).
    const handler = rest[rest.length - 1] as (...a: unknown[]) => void;
    if (typeof handler !== "function") return api.map;
    const layerId = typeof rest[0] === "string" ? rest[0] : undefined;
    state.listenerCalls.push({ method: "on", event, layerId, handler });
    if (!state.handlers.has(event)) state.handlers.set(event, new Set());
    state.handlers.get(event)?.add(handler);
    return api.map;
  };
  const off = (event: string, ...rest: unknown[]) => {
    const handler = rest[rest.length - 1] as (...a: unknown[]) => void;
    if (typeof handler !== "function") return api.map;
    const layerId = typeof rest[0] === "string" ? rest[0] : undefined;
    state.listenerCalls.push({ method: "off", event, layerId, handler });
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
          bump(state.counts.setData, id);
        };
      }
      state.sources.set(id, stored);
    },
    removeSource: (id: string) => {
      state.sources.delete(id);
    },
    getLayer: (id: string) => state.layers.get(id),
    addLayer: (layer: { id: string } & Record<string, unknown>, beforeId?: string) => {
      bump(state.counts.addLayer, layer.id);
      state.paint.delete(layer.id);
      state.layout.delete(layer.id);
      state.filters.delete(layer.id);
      // Shallow-copy, not a reference to the caller's own object: real
      // MapLibre never retains or mutates the spec passed to `addLayer` (it
      // builds its own `StyleLayer`/`Transitionable` state from it), so
      // `setPaintProperty` below must not silently rewrite a caller's — often
      // memoized — layer descriptor. Matches the convention `addSource`
      // already uses for `data`.
      if (layer.paint && typeof layer.paint === "object") {
        state.paint.set(layer.id, { ...(layer.paint as Record<string, unknown>) });
      }
      if (layer.layout && typeof layer.layout === "object") {
        state.layout.set(layer.id, { ...(layer.layout as Record<string, unknown>) });
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
      bump(state.counts.removeLayer, id);
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
      bump(state.counts.setPaintProperty, layerId);
      bump(state.counts.setPaintPropertyByName, `${layerId}:${name}`);
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
      bump(state.counts.setFilter, layerId);
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
    queryRenderedFeatures: (_point: unknown, queryOptions?: { layers?: string[] }) =>
      queryOptions?.layers?.flatMap((layerId) => state.renderedFeatures.get(layerId) ?? []) ?? [],
    querySourceFeatures: () => [],
    project: (lngLat: unknown) => {
      if (options.project && Array.isArray(lngLat)) {
        return options.project([Number(lngLat[0]), Number(lngLat[1])]);
      }
      return state.projectedPoint;
    },
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
    getCenter: () => state.center,
    getBearing: () => state.bearing,
    getPadding: () => state.padding ?? { top: 0, bottom: 0, left: 0, right: 0 },
    setPadding: (padding: Record<string, number>, eventData?: Record<string, unknown>) => {
      stopAnimation();
      state.padding = {
        top: padding.top ?? 0,
        bottom: padding.bottom ?? 0,
        left: padding.left ?? 0,
        right: padding.right ?? 0,
      };
      state.cameraTransitions.push({ method: "setPadding", options: padding, eventData });
      startMove(eventData, false, padding);
    },
    isMoving: () => state.moving,
    getContainer: () => container,
    getBounds: () => {
      const bounds = options.bounds ?? { west: -180, south: -90, east: 180, north: 90 };
      return {
        getWest: () => bounds.west,
        getSouth: () => bounds.south,
        getEast: () => bounds.east,
        getNorth: () => bounds.north,
      };
    },
    getCanvas: () => canvas,
    getCanvasContainer: () => canvas,
    addControl: () => {},
    removeControl: () => {},
    // MapLibre answers with a `LngLat`-shaped centre, not a tuple; code that
    // reads `.lng` has to work here exactly as it does in a browser.
    cameraForBounds: (bounds: unknown, cameraOptions?: Record<string, unknown>) => {
      state.cameraForBoundsCalls.push({ bounds, options: cameraOptions });
      const [[west, south], [east, north]] = bounds as [[number, number], [number, number]];
      return {
        center: { lng: (west + east) / 2, lat: (south + north) / 2 },
        zoom: state.zoom,
        bearing: 0,
      };
    },
    flyTo: (options: Record<string, unknown>, eventData?: Record<string, unknown>) => {
      stopAnimation();
      state.cameraTransitions.push({ method: "flyTo", options, eventData });
      if (!deferAnimatedCamera) applyCamera(options);
      startMove(eventData, true, options);
    },
    easeTo: (options: Record<string, unknown>, eventData?: Record<string, unknown>) => {
      stopAnimation();
      state.cameraTransitions.push({ method: "easeTo", options, eventData });
      if (!deferAnimatedCamera) applyCamera(options);
      startMove(eventData, true, options);
    },
    jumpTo: (options: Record<string, unknown>, eventData?: Record<string, unknown>) => {
      stopAnimation();
      state.cameraTransitions.push({ method: "jumpTo", options, eventData });
      applyCamera(options);
      startMove(eventData, false, options);
    },
    fitBounds: (
      bounds: unknown,
      options?: Record<string, unknown>,
      eventData?: Record<string, unknown>,
    ) => {
      state.cameraTransitions.push({
        method: "fitBounds",
        options: { bounds, ...options },
        eventData,
      });
    },
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
    setRenderedFeatures(layerId, features) {
      state.renderedFeatures.set(layerId, features);
    },
    registeredAttributions() {
      return [...state.sources.values()].map((s) => (s.attribution as string | undefined) ?? "");
    },
    settleCameraAnimation() {
      const pending = animating;
      if (!pending) return;
      animating = null;
      applyCamera(pending.options);
      if (emitCameraEvents) api.emit("moveend", pending.eventData ?? {});
    },
  };
  return api;
}
