import { createOverlayStore, useLayerStore, useNavigationStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import {
  NEUTRAL_SCENE_LIGHT,
  NIGHT_SCENE_LIGHT,
  sunVector,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { INSTANCE_STRIDE, type Instances } from "../web/derive/forest";
import type { Selection } from "../web/selection";
import type { ObjectsQuery } from "../web/worker-client";

let fake: FakeMap;
let mapRef: { current: FakeMap["map"] };
const env = vi.hoisted(() => ({ streetDetailTilesUrl: "/tiles/data/street_detail.json" }));
const hooks = vi.hoisted(() => ({
  calls: [] as Array<{
    key: string;
    visible: boolean;
    options?: { resolveCustomContributors?: () => readonly { sourceId: string }[] };
  }>,
}));
const worker = vi.hoisted(() => ({
  queries: [] as Array<{
    query: ObjectsQuery;
    signal?: AbortSignal;
    resolve(v: Instances[] | null): void;
  }>,
}));
const sceneMock = vi.hoisted(() => ({
  created: 0,
  options: undefined as undefined | { lighting: Record<string, unknown> },
  layer: undefined as unknown as Record<string, ReturnType<typeof vi.fn> | string>,
  mapped: false,
}));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => env,
  useOptionalEnv: () => env,
}));
vi.mock("@/integration-api/map/offlinePackage", () => ({ useOfflinePackageActive: () => false }));
vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: (
    key: string,
    _layers: readonly string[],
    visible: boolean,
    options?: never,
  ) => {
    hooks.calls.push({ key, visible, options });
  },
}));
vi.mock("@openmapx/integration-framework/react", async () => {
  const manifest = (await import("../manifest.json")).default;
  return {
    useIntegrationRegistry: () => ({
      findDataSource: (id: string) => manifest.dataSources.find((s) => s.sourceId === id),
    }),
  };
});
vi.mock("../web/paint-protocol", async (original) => ({
  ...(await original<typeof import("../web/paint-protocol")>()),
  ensurePaintProtocol: vi.fn(),
}));
vi.mock("../web/worker-client", async (original) => ({
  absoluteTemplate: (await original<typeof import("../web/worker-client")>()).absoluteTemplate,
  createMapDetailsWorker: () => ({
    paint: vi.fn(async () => null),
    objects: (query: ObjectsQuery, signal?: AbortSignal) =>
      new Promise<Instances[] | null>((resolve) => {
        worker.queries.push({ query, signal, resolve });
        signal?.addEventListener("abort", () => resolve(null));
      }),
    dispose: vi.fn(),
  }),
}));
vi.mock("../web/scene", () => ({
  createMapDetailsScene: (options: typeof sceneMock.options) => {
    sceneMock.created += 1;
    sceneMock.options = options;
    sceneMock.layer = {
      id: "openmapx-map-details-objects",
      type: "custom",
      renderingMode: "3d",
      onAdd: vi.fn(),
      render: vi.fn(),
      setInstances: vi.fn(),
      setLighting: vi.fn(),
      setSatellite: vi.fn(),
      setTerrain: vi.fn(),
      drewMapped: vi.fn(() => sceneMock.mapped),
      dispose: vi.fn(),
    };
    return { layer: sceneMock.layer };
  },
}));

import { MapDetailsLayer } from "../map-layer";

const buildings = createOverlayStore({ overlayId: "3d-buildings", extra: {} });
const OBJECTS = "openmapx-map-details-objects";
const CENTER = { lng: 13.41, lat: 52.52 };

async function flush() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await Promise.resolve();
    });
}
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}
async function activate() {
  act(() => buildings.setState({ panelOpen: true, layerVisible: true }));
  await flush();
  await advance(200);
}
const lastSelection = () =>
  (sceneMock.layer.setInstances as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as
    | Selection
    | undefined;
function instances(mapped: number): Instances[] {
  const data = new Float32Array(INSTANCE_STRIDE);
  data.set([100, 100, 0, 6, 6, 0, 0, mapped]);
  return [{ kind: mapped ? "lamp_arm" : "broadleaf", count: 1, data }];
}

beforeEach(() => {
  vi.useFakeTimers();
  env.streetDetailTilesUrl = "/tiles/data/street_detail.json";
  hooks.calls = [];
  worker.queries = [];
  sceneMock.created = 0;
  sceneMock.mapped = false;
  useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
  fake = createFakeMap({
    zoom: 17,
    pitch: 60,
    center: CENTER,
    bounds: { west: 13.405, south: 52.517, east: 13.415, north: 52.523 },
  });
  fake.map.addSource("openmaptiles", {
    type: "vector",
    tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"],
    maxzoom: 14,
  } as never);
  fake.map.addLayer({
    id: "landcover-wood",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landcover",
  } as never);
  mapRef = { current: fake.map };
  buildings.setState({ panelOpen: false, layerVisible: false });
  useNavigationStore.setState({ status: "idle" });
  useLayerStore.setState({ activeLayer: "default" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ tiles: ["https://maps.example/street/{z}/{x}/{y}.pbf"] })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("objects wiring", () => {
  it("loads the scene module only on first activation and adds its layer", async () => {
    render(<MapDetailsLayer />);
    await flush();
    expect(sceneMock.created).toBe(0);
    await activate();
    expect(sceneMock.created).toBe(1);
    expect(fake.state.layers.has(OBJECTS)).toBe(true);
  });

  it("re-adds the objects layer once after a style swap", async () => {
    render(<MapDetailsLayer />);
    await activate();
    const before = fake.state.counts.addLayer.get(OBJECTS) ?? 0;
    act(() => fake.map.setStyle({ version: 8, sources: {}, layers: [] }));
    await flush();
    expect(fake.state.counts.addLayer.get(OBJECTS)).toBe(before + 1);
  });

  describe("scene slot", () => {
    const slotOf = () => layerRegistrations().find((r) => r.id === OBJECTS);
    afterEach(() => {
      act(() => useNavigationSceneStore.getState().setActive(false));
    });

    it("adds its layer in scene-3d while the navigation scene is active", async () => {
      act(() => useNavigationSceneStore.getState().setActive(true));
      render(<MapDetailsLayer />);
      await activate();
      expect(slotOf()).toMatchObject({ slot: "scene-3d", order: 13 });
    });

    it("moves back to area-overlays when it ends", async () => {
      render(<MapDetailsLayer />);
      await activate();
      expect(slotOf()?.slot).toBe("area-overlays");
      act(() => useNavigationSceneStore.getState().setActive(true));
      expect(slotOf()?.slot).toBe("scene-3d");
      act(() => useNavigationSceneStore.getState().setActive(false));
      expect(slotOf()).toMatchObject({ slot: "area-overlays", order: 13 });
    });

    it("a style swap during 3D navigation re-adds it in scene-3d", async () => {
      act(() => useNavigationSceneStore.getState().setActive(true));
      render(<MapDetailsLayer />);
      await activate();
      act(() => fake.map.setStyle({ version: 8, sources: {}, layers: [] }));
      await flush();
      expect(fake.state.layers.has(OBJECTS)).toBe(true);
      expect(slotOf()?.slot).toBe("scene-3d");
    });
  });

  it("releases the scene 30 s after deactivation", async () => {
    render(<MapDetailsLayer />);
    await activate();
    act(() => buildings.setState({ panelOpen: false, layerVisible: false }));
    await flush();
    expect(fake.state.layers.has(OBJECTS)).toBe(false);
    await advance(29_000);
    expect(sceneMock.layer.dispose).not.toHaveBeenCalled();
    await advance(1_500);
    expect(sceneMock.layer.dispose).toHaveBeenCalledTimes(1);
  });

  it("asks the worker for each visible cell with the forest and street templates", async () => {
    render(<MapDetailsLayer />);
    await activate();
    expect(worker.queries.length).toBeGreaterThan(0);
    for (const { query } of worker.queries) {
      expect(query.basemapTemplates).toEqual(["https://tiles.example/{z}/{x}/{y}.pbf"]);
      expect(query.basemapMaxzoom).toBe(14);
      expect(query.streetTemplate).toBe("https://maps.example/street/{z}/{x}/{y}.pbf");
    }
  });

  it("plants forests without street detail", async () => {
    env.streetDetailTilesUrl = "";
    render(<MapDetailsLayer />);
    await activate();
    expect(worker.queries.length).toBeGreaterThan(0);
    expect(worker.queries.every(({ query }) => query.streetTemplate === null)).toBe(true);
  });

  it("asks again with the street template once a late TileJSON arrives", async () => {
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    render(<MapDetailsLayer />);
    await activate();
    expect(worker.queries.length).toBeGreaterThan(0);
    expect(worker.queries.every(({ query }) => query.streetTemplate === null)).toBe(true);
    const before = worker.queries.length;
    answer(Response.json({ tiles: ["https://maps.example/street/{z}/{x}/{y}.pbf"] }));
    await flush();
    const later = worker.queries.slice(before);
    expect(later.length).toBeGreaterThan(0);
    expect(
      later.every(
        ({ query }) => query.streetTemplate === "https://maps.example/street/{z}/{x}/{y}.pbf",
      ),
    ).toBe(true);
  });

  it("rebuilds after the camera settles and ignores superseded answers", async () => {
    render(<MapDetailsLayer />);
    await activate();
    const first = worker.queries.slice();
    fake.state.center = { lng: 13.43, lat: 52.52 };
    fake.state.bounds = { west: 13.425, south: 52.517, east: 13.435, north: 52.523 };
    act(() => fake.emit("moveend"));
    await advance(100);
    expect(worker.queries.length).toBe(first.length);
    await advance(100);
    expect(worker.queries.length).toBeGreaterThan(first.length);
    expect(first.every(({ signal }) => signal?.aborted)).toBe(true);
    const calls = (sceneMock.layer.setInstances as ReturnType<typeof vi.fn>).mock.calls.length;
    for (const { resolve } of first) resolve(instances(1));
    await advance(300);
    expect((sceneMock.layer.setInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      calls,
    );
  });

  it("rebuilds during a long move", async () => {
    render(<MapDetailsLayer />);
    await activate();
    const count = worker.queries.length;
    fake.state.center = { lng: 13.4105, lat: 52.52 };
    act(() => fake.emit("move"));
    await flush();
    expect(worker.queries.length).toBe(count);
    fake.state.center = { lng: 13.4135, lat: 52.52 };
    fake.state.bounds = { west: 13.408, south: 52.517, east: 13.418, north: 52.523 };
    act(() => fake.emit("move"));
    await flush();
    expect(worker.queries.length).toBeGreaterThan(count);
  });

  it("selects instances as worker results arrive", async () => {
    render(<MapDetailsLayer />);
    await activate();
    worker.queries[0]?.resolve(instances(0));
    await advance(300);
    const selection = lastSelection();
    expect((selection?.near.length ?? 0) + (selection?.far.length ?? 0)).toBeGreaterThan(0);
  });

  it("samples terrain per cell and resamples when terrain tiles arrive", async () => {
    fake.state.terrain = { source: "dem" };
    const terrainCalls = () => (sceneMock.layer.setTerrain as ReturnType<typeof vi.fn>).mock.calls;
    render(<MapDetailsLayer />);
    await activate();
    worker.queries[0]?.resolve(instances(0));
    await advance(300);
    const sampled = terrainCalls().length;
    expect(sampled).toBeGreaterThan(0);
    expect(terrainCalls()[0]?.[1]).toBe("pending");
    act(() => fake.emit("sourcedata", { sourceId: "dem" }));
    await advance(300);
    expect(terrainCalls().length).toBeGreaterThan(sampled);
  });

  it("passes the shared scene light, night and satellite through", async () => {
    render(<MapDetailsLayer />);
    await activate();
    expect(sceneMock.options?.lighting).toMatchObject({
      direction: sunVector(NEUTRAL_SCENE_LIGHT),
      night: false,
    });
    act(() => useSceneLightStore.setState({ light: NIGHT_SCENE_LIGHT }));
    await flush();
    expect(sceneMock.layer.setLighting).toHaveBeenLastCalledWith(
      expect.objectContaining({ night: true }),
    );
    act(() => useLayerStore.setState({ activeLayer: "satellite" }));
    await flush();
    expect(sceneMock.layer.setSatellite).toHaveBeenLastCalledWith(true);
  });

  describe("navigation mode", () => {
    const enter3dNavigation = () =>
      act(() => {
        useNavigationStore.setState({ status: "navigating" });
        useNavigationSceneStore.getState().setActive(true);
      });
    afterEach(() => {
      act(() => {
        useNavigationSceneStore.getState().setActive(false);
        useNavigationStore.setState({ status: "idle" });
      });
    });

    it("navigation mode requests no basemap templates", async () => {
      enter3dNavigation();
      render(<MapDetailsLayer />);
      await activate();
      expect(worker.queries.length).toBeGreaterThan(0);
      expect(worker.queries.every((q) => q.query.basemapTemplates.length === 0)).toBe(true);
    });

    it("objects layer keeps only signals and signs in navigation mode", async () => {
      enter3dNavigation();
      render(<MapDetailsLayer />);
      await activate();
      const mixed: Instances[] = (
        ["lamp_arm", "signal", "stop", "broadleaf", "give_way"] as const
      ).map((kind) => {
        const data = new Float32Array(INSTANCE_STRIDE);
        data.set([100, 100, 0, 3, 3, 0, 0, 1]);
        return { kind, count: 1, data };
      });
      for (const query of worker.queries) query.resolve(mixed);
      await advance(300);
      const selection = lastSelection();
      const kinds = new Set(
        [...(selection?.near ?? []), ...(selection?.far ?? [])].map((s) => s.kind),
      );
      expect([...kinds].sort()).toEqual(["give_way", "signal", "stop"]);
    });

    it("publishes that street objects draw signals at zoom 16 and above", async () => {
      enter3dNavigation();
      render(<MapDetailsLayer />);
      await activate();
      expect(useNavigationSceneStore.getState().streetObjectsDrawn).toBe(true);
    });

    it("navigation mode without street detail keeps buildings and landmarks", async () => {
      env.streetDetailTilesUrl = "";
      enter3dNavigation();
      render(<MapDetailsLayer />);
      await activate();
      // The objects scene still runs (activation does not need street detail),
      // but no street objects stand in for the flat signal icons.
      expect(sceneMock.created).toBe(1);
      expect(useNavigationSceneStore.getState().streetObjectsDrawn).toBe(false);
    });
  });

  it("credits OpenStreetMap only while street objects are drawn", async () => {
    render(<MapDetailsLayer />);
    await activate();
    const call = hooks.calls.filter((c) => c.key === "map-details-objects").at(-1);
    expect(call?.visible).toBe(true);
    expect(call?.options?.resolveCustomContributors?.()).toEqual([]);
    sceneMock.mapped = true;
    expect(call?.options?.resolveCustomContributors?.().map((c) => c.sourceId)).toEqual([
      "osm-street-detail",
    ]);
  });

  it("does nothing while navigating", async () => {
    useNavigationStore.setState({ status: "navigating" });
    render(<MapDetailsLayer />);
    await activate();
    expect(sceneMock.created).toBe(0);
    expect(worker.queries).toEqual([]);
  });
});
