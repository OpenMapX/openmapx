import {
  createOverlayStore,
  useBuildingReplacementStore,
  useLayerStore,
  useNavigationStore,
  usePlaceStore,
} from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import {
  NEUTRAL_SCENE_LIGHT,
  NIGHT_SCENE_LIGHT,
  sunVector,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import type { Candidate } from "../web/loader";
import type { WireAsset } from "../wire";

let fake: FakeMap;
let mapRef: { current: FakeMap["map"] };
let styleVersion = 0;

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
  useOptionalEnv: () => ({ apiUrl: "https://api.test" }),
}));

const hooks = vi.hoisted(() => ({
  attributionOptions: undefined as
    | { resolveCustomContributors?: () => readonly { sourceId: string }[] }
    | undefined,
  attributionVisible: false,
}));
vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: (
    _key: string,
    _layers: readonly string[],
    visible: boolean,
    options?: typeof hooks.attributionOptions,
  ) => {
    hooks.attributionVisible = visible;
    hooks.attributionOptions = options;
  },
}));

const sceneMock = vi.hoisted(() => {
  const state = {
    created: 0,
    options: undefined as
      | { onUnsupported(): void; onFrame(drawn: readonly string[]): void }
      | undefined,
    drawn: [] as string[],
    pick: null as string | null,
    loaded: new Map<string, unknown>(),
    /** Assets whose low level of detail is not loaded (only the detail one is). */
    lowMissing: new Set<string>(),
    listeners: new Set<() => void>(),
    layer: undefined as unknown as Record<
      string,
      ReturnType<typeof vi.fn> | string | (() => unknown)
    >,
    dispose: undefined as unknown as ReturnType<typeof vi.fn>,
  };
  return state;
});

vi.mock("../web/scene", () => ({
  createLandmarkScene: (options: typeof sceneMock.options) => {
    sceneMock.created += 1;
    sceneMock.options = options;
    sceneMock.layer = {
      id: "openmapx-landmark-models",
      type: "custom",
      renderingMode: "3d",
      onAdd: vi.fn(),
      render: vi.fn(),
      setPlaced: vi.fn(),
      setNight: vi.fn(),
      setLighting: vi.fn(),
      drawnAssetIds: () => sceneMock.drawn,
      pick: vi.fn(() => sceneMock.pick),
    };
    sceneMock.dispose = vi.fn();
    return {
      layer: sceneMock.layer,
      models: {
        request: vi.fn(),
        best: (id: string) => sceneMock.loaded.get(id),
        get: (id: string, lod: string) =>
          lod === "low" && sceneMock.lowMissing.has(id) ? undefined : sceneMock.loaded.get(id),
        touch: vi.fn(),
        cancelExcept: vi.fn(),
        failure: () => "none",
        onChange: (listener: () => void) => {
          sceneMock.listeners.add(listener);
          return () => sceneMock.listeners.delete(listener);
        },
        dispose: vi.fn(),
      },
      dispose: sceneMock.dispose,
    };
  },
}));

const catalogueMock = vi.hoisted(() => ({ candidates: [] as Candidate[] }));
vi.mock("../web/loader", () => ({
  LandmarkCatalogue: class {
    async ensureCoverage() {
      return { revision: "r", occupied: [] };
    }
    async candidates() {
      return catalogueMock.candidates;
    }
  },
}));

import { LandmarkModelsLayer } from "../map-layer";

const buildings = createOverlayStore({ overlayId: "3d-buildings", extra: {} });
const LAYER_ID = "openmapx-landmark-models";

function wireAsset(id: string, overrides: Partial<WireAsset> = {}): WireAsset {
  return {
    id,
    name: `Landmark ${id}`,
    anchor: [2.2945, 48.8584],
    bounds: [2.294, 48.858, 2.295, 48.859],
    elevationM: 0,
    minZoom: 15,
    models: { low: `/api/integrations/landmark-models/models/p/${"a".repeat(64)}.glb` },
    replaces: ["way/226413508"],
    footprint: {
      type: "Polygon",
      coordinates: [
        [
          [2.2944, 48.8582],
          [2.2946, 48.8582],
          [2.2946, 48.8586],
          [2.2944, 48.8582],
        ],
      ],
    },
    grounding: "anchor",
    derivedFootprintAllowed: false,
    receipts: [0],
    ...overrides,
  };
}

const RECEIPT = { sourceId: "open-landmarks", name: "Arc de Triomphe" };

/** A 40 m × 20 m box, 30 m tall, in the GLB frame (X east, Y up, Z south). */
function boxPositions(): Float32Array {
  const points: number[] = [];
  for (const x of [-20, 20])
    for (const y of [0, 30]) for (const z of [-10, 10]) points.push(x, y, z);
  return new Float32Array(points);
}

function loadedModel(positions: Float32Array = new Float32Array()) {
  return {
    key: "k",
    scene: {},
    positions,
    bytesEstimate: 1,
    dispose: vi.fn(),
    setNight: vi.fn(),
  };
}

async function flush() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await Promise.resolve();
    });
}

async function activate() {
  act(() => buildings.setState({ panelOpen: true, layerVisible: true }));
  await flush();
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  await flush();
}

function replacements() {
  return [...(useBuildingReplacementStore.getState().replacements.get("landmark-models") ?? [])];
}

beforeEach(() => {
  vi.useFakeTimers();
  useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
  styleVersion = 0;
  fake = createFakeMap({
    zoom: 16,
    pitch: 45,
    bounds: { west: 2.28, south: 48.85, east: 2.31, north: 48.87 },
  });
  mapRef = { current: fake.map };
  sceneMock.created = 0;
  sceneMock.drawn = [];
  sceneMock.pick = null;
  sceneMock.loaded = new Map([["landmark-models-open-landmarks:arc", loadedModel()]]);
  sceneMock.lowMissing.clear();
  sceneMock.listeners.clear();
  catalogueMock.candidates = [
    { asset: wireAsset("landmark-models-open-landmarks:arc"), receipts: [RECEIPT] },
  ];
  buildings.setState({ panelOpen: false, layerVisible: false });
  useNavigationStore.setState({ status: "idle" });
  useLayerStore.setState({ activeLayer: "default" });
  const store = useBuildingReplacementStore.getState();
  for (const owner of store.owners) store.clear(owner);
  store.setMaskingAvailable(true);
  usePlaceStore.getState().setSelectedPlace(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LandmarkModelsLayer", () => {
  it("stays inactive until the 3D view is selected and the map is tilted", async () => {
    fake.state.pitch = 0;
    render(<LandmarkModelsLayer />);
    act(() => buildings.setState({ panelOpen: true, layerVisible: true }));
    await flush();
    expect(fake.state.layers.has(LAYER_ID)).toBe(false);
    fake.state.pitch = 45;
    act(() => fake.emit("pitch"));
    await flush();
    expect(fake.state.layers.has(LAYER_ID)).toBe(true);
  });

  it("stays inactive while navigating or below zoom 13 or without masking", async () => {
    render(<LandmarkModelsLayer />);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    await activate();
    expect(fake.state.layers.has(LAYER_ID)).toBe(false);
    act(() => useNavigationStore.setState({ status: "idle" }));
    act(() => useBuildingReplacementStore.getState().setMaskingAvailable(false));
    await flush();
    expect(fake.state.layers.has(LAYER_ID)).toBe(false);
    act(() => useBuildingReplacementStore.getState().setMaskingAvailable(true));
    fake.state.zoom = 12;
    act(() => fake.emit("zoom"));
    await flush();
    expect(fake.state.layers.has(LAYER_ID)).toBe(false);
  });

  it("does not import the scene module until first active", async () => {
    render(<LandmarkModelsLayer />);
    await flush();
    expect(sceneMock.created).toBe(0);
    expect(useBuildingReplacementStore.getState().owners.has("landmark-models")).toBe(false);
    await activate();
    expect(sceneMock.created).toBe(1);
    expect(useBuildingReplacementStore.getState().owners.has("landmark-models")).toBe(true);
  });

  it("re-adds the custom layer after a style swap", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    fake.state.layers.delete(LAYER_ID);
    act(() => fake.emit("styledata"));
    expect(fake.state.layers.get(LAYER_ID)).toBe(sceneMock.layer);
  });

  it("publishes replacements for placed, grounded models and empties them when inactive", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    expect(sceneMock.layer.setPlaced).toHaveBeenLastCalledWith([
      expect.objectContaining({ assetId: "landmark-models-open-landmarks:arc", groundM: 0 }),
    ]);
    expect(replacements().map((r) => r.id)).toEqual(["landmark-models-open-landmarks:arc"]);
    expect(replacements()[0]?.featureIds).toEqual([2264135082]);
    act(() => buildings.setState({ panelOpen: false, layerVisible: false }));
    await flush();
    expect(replacements()).toEqual([]);
  });

  it("keeps a replacement while its model is outside the view", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    act(() => sceneMock.options?.onFrame(["landmark-models-open-landmarks:arc"]));
    act(() => sceneMock.options?.onFrame([]));
    expect(replacements().map((r) => r.id)).toEqual(["landmark-models-open-landmarks:arc"]);
  });

  it("withdraws a replacement when its model is evicted or fails", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    sceneMock.loaded.clear();
    act(() => {
      for (const listener of sceneMock.listeners) listener();
    });
    expect(replacements()).toEqual([]);
  });

  it("republishes a replacement once its derived footprint is known", async () => {
    const id = "landmark-models-barrelman:tower";
    catalogueMock.candidates = [
      {
        asset: wireAsset(id, { footprint: undefined, derivedFootprintAllowed: true }),
        receipts: [RECEIPT],
      },
    ];
    sceneMock.loaded = new Map([[id, loadedModel(boxPositions())]]);
    sceneMock.lowMissing.add(id);
    render(<LandmarkModelsLayer />);
    await activate();
    expect(replacements()[0]?.footprint).toBeUndefined();
    sceneMock.lowMissing.clear();
    act(() => {
      for (const listener of sceneMock.listeners) listener();
    });
    expect(replacements()[0]?.footprint?.type).toBe("MultiPolygon");
  });

  it("clears its replacements and releases the scene when unmounted while active", async () => {
    const view = render(<LandmarkModelsLayer />);
    await activate();
    expect(replacements()).toHaveLength(1);
    view.unmount();
    expect(replacements()).toEqual([]);
    expect(sceneMock.dispose).toHaveBeenCalled();
  });

  it("publishes no replacements when the layer reports unsupported", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    act(() => sceneMock.options?.onFrame(["landmark-models-open-landmarks:arc"]));
    act(() => sceneMock.options?.onUnsupported());
    await flush();
    expect(replacements()).toEqual([]);
    expect(fake.state.layers.has(LAYER_ID)).toBe(false);
  });

  it("re-evaluates grounding on sourcedata, terrain and idle", async () => {
    let state: "loading" | "loaded" = "loading";
    fake.state.terrain = { source: "dem" };
    (fake.map as unknown as { terrain: unknown }).terrain = {
      getElevationAndDEMStateForLngLat: () => ({ elevation: 0, demState: state }),
      getDrawnElevationForLngLat: () => (state === "loaded" ? 35 : undefined),
    };
    render(<LandmarkModelsLayer />);
    await activate();
    expect(sceneMock.layer.setPlaced).toHaveBeenLastCalledWith([]);
    state = "loaded";
    (sceneMock.layer.setPlaced as ReturnType<typeof vi.fn>).mockClear();
    act(() => fake.emit("sourcedata", { sourceId: "basemap" }));
    expect(sceneMock.layer.setPlaced).not.toHaveBeenCalled();
    for (const [event, data] of [
      ["sourcedata", { sourceId: "dem" }],
      ["terrain", {}],
      ["idle", {}],
    ] as const) {
      (sceneMock.layer.setPlaced as ReturnType<typeof vi.fn>).mockClear();
      act(() => fake.emit(event, data));
      expect(sceneMock.layer.setPlaced).toHaveBeenLastCalledWith([
        expect.objectContaining({ groundM: 35 }),
      ]);
    }
  });

  it("forgets flat-map ground heights when terrain is switched on", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    expect(sceneMock.layer.setPlaced).toHaveBeenLastCalledWith([
      expect.objectContaining({ groundM: 0 }),
    ]);
    fake.state.terrain = { source: "dem" };
    (fake.map as unknown as { terrain: unknown }).terrain = {
      getElevationAndDEMStateForLngLat: () => ({ elevation: 0, demState: "loading" }),
      getDrawnElevationForLngLat: () => undefined,
    };
    act(() => fake.emit("terrain", {}));
    expect(sceneMock.layer.setPlaced).toHaveBeenLastCalledWith([]);
    expect(replacements()).toEqual([]);
  });

  it("keeps the last ground height while a re-evaluation is pending", async () => {
    let state: "loading" | "loaded" = "loaded";
    fake.state.terrain = { source: "dem" };
    (fake.map as unknown as { terrain: unknown }).terrain = {
      getElevationAndDEMStateForLngLat: () => ({ elevation: 0, demState: state }),
      getDrawnElevationForLngLat: () => (state === "loaded" ? 35 : undefined),
    };
    render(<LandmarkModelsLayer />);
    await activate();
    state = "loading";
    act(() => fake.emit("idle"));
    expect(sceneMock.layer.setPlaced).toHaveBeenLastCalledWith([
      expect.objectContaining({ groundM: 35 }),
    ]);
  });

  it("releases GPU resources 30 seconds after becoming inactive", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    act(() => buildings.setState({ panelOpen: false, layerVisible: false }));
    await flush();
    act(() => vi.advanceTimersByTime(29_000));
    expect(sceneMock.dispose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(sceneMock.dispose).toHaveBeenCalled();
  });

  it("clicking a model opens the osm place", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    act(() => sceneMock.options?.onFrame(["landmark-models-open-landmarks:arc"]));
    sceneMock.pick = "landmark-models-open-landmarks:arc";
    act(() =>
      fake.emit("click", {
        target: fake.map,
        point: { x: 10, y: 10 },
        lngLat: { lng: 2.2945, lat: 48.8584 },
        originalEvent: new MouseEvent("click"),
      }),
    );
    const place = usePlaceStore.getState().selectedPlace;
    expect(place?.name).toBe("Landmark landmark-models-open-landmarks:arc");
    expect(place?.ids.osm).toBe("way/226413508");
  });

  it("leaves a click to an icon drawn above the model", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    sceneMock.pick = "landmark-models-open-landmarks:arc";
    const click = () => ({
      target: fake.map,
      point: { x: 10, y: 10 },
      originalEvent: new MouseEvent("click"),
    });
    expect(getMapClickOwner(click())).toBe("custom-content");
    fake.state.layers.set("poi-icons", {
      id: "poi-icons",
      type: "symbol",
      layout: { "icon-image": "poi" },
    });
    fake.state.layers.set("street-names", { id: "street-names", type: "symbol", layout: {} });
    fake.setRenderedFeatures("street-names", [{ properties: {} } as never]);
    expect(getMapClickOwner(click())).toBe("custom-content");
    fake.setRenderedFeatures("poi-icons", [{ properties: {} } as never]);
    expect(getMapClickOwner(click())).toBeNull();
  });

  it("shows the pointer over a model, but not under an icon drawn above it", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    const cursor = () => fake.map.getCanvasContainer().style.cursor;
    const move = () => act(() => fake.emit("mousemove", { point: { x: 10, y: 10 } }));
    move();
    expect(cursor()).toBe("");
    sceneMock.pick = "landmark-models-open-landmarks:arc";
    move();
    expect(cursor()).toBe("pointer");
    fake.state.layers.set("poi-icons", {
      id: "poi-icons",
      type: "symbol",
      layout: { "icon-image": "poi" },
    });
    fake.setRenderedFeatures("poi-icons", [{ properties: {} } as never]);
    move();
    expect(cursor()).toBe("");
  });

  it("credits only drawn models", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    expect(hooks.attributionVisible).toBe(true);
    expect(hooks.attributionOptions?.resolveCustomContributors?.()).toEqual([]);
    act(() => sceneMock.options?.onFrame(["landmark-models-open-landmarks:arc"]));
    sceneMock.drawn = ["landmark-models-open-landmarks:arc"];
    expect(hooks.attributionOptions?.resolveCustomContributors?.()).toEqual([RECEIPT]);
  });

  it("takes night and light from the scene light", async () => {
    render(<LandmarkModelsLayer />);
    await activate();
    act(() => useSceneLightStore.getState().publish(NIGHT_SCENE_LIGHT));
    expect(sceneMock.layer.setNight).toHaveBeenLastCalledWith(true);
    act(() => useSceneLightStore.getState().publish(NEUTRAL_SCENE_LIGHT));
    expect(sceneMock.layer.setNight).toHaveBeenLastCalledWith(false);
    expect(sceneMock.layer.setLighting).toHaveBeenLastCalledWith({
      direction: sunVector(NEUTRAL_SCENE_LIGHT),
      color: "#fff4df",
      intensity: 2.2,
      ambientColor: "#ffffff",
      ambientIntensity: 1.4,
    });
  });
});
