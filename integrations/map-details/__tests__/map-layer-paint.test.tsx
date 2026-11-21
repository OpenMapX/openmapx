import { createOverlayStore, useLayerStore, useNavigationStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEUTRAL_SCENE_LIGHT,
  NIGHT_SCENE_LIGHT,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { PAINT_SOURCE_ID } from "../web/paint-protocol";
import { PAINT_LAYER_ID, PAINT_PALETTE, paintOpacity } from "../web/paint-style";

let fake: FakeMap;
let mapRef: { current: FakeMap["map"] };
let styleVersion = 0;
const env = vi.hoisted(() => ({ streetDetailTilesUrl: "/tiles/data/street_detail.json" }));
const offline = vi.hoisted(() => ({ active: false }));
const hooks = vi.hoisted(() => ({
  calls: [] as Array<{
    key: string;
    layers: readonly string[];
    visible: boolean;
    options: unknown;
  }>,
}));
const protocol = vi.hoisted(() => ({ ensure: vi.fn() }));
const workers = vi.hoisted(() => ({ created: 0, disposed: 0 }));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => env,
  useOptionalEnv: () => env,
}));
vi.mock("@/integration-api/map/offlinePackage", () => ({
  useOfflinePackageActive: () => offline.active,
}));
vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: (
    key: string,
    layers: readonly string[],
    visible: boolean,
    options?: unknown,
  ) => {
    hooks.calls.push({ key, layers, visible, options });
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
  ensurePaintProtocol: protocol.ensure,
}));
vi.mock("../web/worker-client", async (original) => ({
  absoluteTemplate: (await original<typeof import("../web/worker-client")>()).absoluteTemplate,
  createMapDetailsWorker: () => {
    workers.created += 1;
    return {
      paint: vi.fn(async () => null),
      objects: vi.fn(async () => []),
      dispose: () => {
        workers.disposed += 1;
      },
    };
  },
}));

import { MapDetailsLayer } from "../map-layer";

const buildings = createOverlayStore({ overlayId: "3d-buildings", extra: {} });

async function flush() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await Promise.resolve();
    });
}

async function activate() {
  act(() => buildings.setState({ panelOpen: true, layerVisible: true }));
  await flush();
}

const tileJson = { tiles: ["https://maps.example/tiles/data/street_detail/{z}/{x}/{y}.pbf"] };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  styleVersion = 0;
  env.streetDetailTilesUrl = "/tiles/data/street_detail.json";
  offline.active = false;
  hooks.calls = [];
  protocol.ensure.mockClear();
  workers.created = 0;
  workers.disposed = 0;
  useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
  fake = createFakeMap({ zoom: 17, pitch: 60, center: { lng: 13.41, lat: 52.52 } });
  mapRef = { current: fake.map };
  buildings.setState({ panelOpen: false, layerVisible: false });
  useNavigationStore.setState({ status: "idle" });
  useLayerStore.setState({ activeLayer: "default" });
  fetchMock = vi.fn(async () => Response.json(tileJson));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const layer = () => fake.state.layers.get(PAINT_LAYER_ID) as Record<string, unknown> | undefined;
const visibility = () => fake.state.layout.get(PAINT_LAYER_ID)?.visibility;
const lastAttribution = () => hooks.calls.filter((c) => c.key === "map-details-paint").at(-1);

describe("street paint layer", () => {
  it("adds the paint source from the street detail TileJSON once active", async () => {
    render(<MapDetailsLayer />);
    expect(fetchMock).not.toHaveBeenCalled();
    await activate();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/tiles/data/street_detail.json", document.baseURI).href,
    );
    expect(fake.state.sources.get(PAINT_SOURCE_ID)).toMatchObject({
      type: "vector",
      tiles: ["openmapx-street-detail://{z}/{x}/{y}"],
      minzoom: 16,
      maxzoom: 18,
    });
    expect(layer()).toMatchObject({ id: PAINT_LAYER_ID, type: "fill" });
    expect(visibility()).toBe("visible");
    expect(protocol.ensure).toHaveBeenCalled();
    const [getClient, getTemplate] = protocol.ensure.mock.calls.at(-1) as [
      () => unknown,
      () => string,
    ];
    expect(getClient()).not.toBeNull();
    expect(getTemplate()).toBe(tileJson.tiles[0]);
    expect(workers.created).toBe(1);
  });

  it("adds nothing without street detail or while an offline package is active", async () => {
    env.streetDetailTilesUrl = "";
    const first = render(<MapDetailsLayer />);
    await activate();
    expect(fake.state.sources.has(PAINT_SOURCE_ID)).toBe(false);
    first.unmount();
    env.streetDetailTilesUrl = "/tiles/data/street_detail.json";
    offline.active = true;
    render(<MapDetailsLayer />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.state.sources.has(PAINT_SOURCE_ID)).toBe(false);
  });

  it("logs a failed TileJSON once and adds no source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    render(<MapDetailsLayer />);
    await activate();
    expect(fake.state.sources.has(PAINT_SOURCE_ID)).toBe(false);
    act(() => fake.emit("moveend"));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("hides the paint when inactive, flat, navigating or on satellite", async () => {
    render(<MapDetailsLayer />);
    await activate();
    expect(visibility()).toBe("visible");
    act(() => useLayerStore.setState({ activeLayer: "satellite" }));
    await flush();
    expect(visibility()).toBe("none");
    act(() => useLayerStore.setState({ activeLayer: "default" }));
    await flush();
    expect(visibility()).toBe("visible");
    act(() => useNavigationStore.setState({ status: "navigating" }));
    await flush();
    expect(visibility()).toBe("none");
    act(() => useNavigationStore.setState({ status: "idle" }));
    fake.state.pitch = 0;
    act(() => fake.emit("pitch"));
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    await flush();
    expect(visibility()).toBe("none");
    expect(fake.state.sources.has(PAINT_SOURCE_ID)).toBe(true);
  });

  it("follows the tilt fade, throttled", async () => {
    render(<MapDetailsLayer />);
    await activate();
    expect(fake.state.paint.get(PAINT_LAYER_ID)?.["fill-opacity"]).toEqual(paintOpacity(1));
    const before =
      fake.state.counts.setPaintPropertyByName.get(`${PAINT_LAYER_ID}:fill-opacity`) ?? 0;
    for (const pitch of [9, 7, 5.25]) {
      fake.state.pitch = pitch;
      act(() => fake.emit("pitch"));
    }
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    await flush();
    expect(fake.state.paint.get(PAINT_LAYER_ID)?.["fill-opacity"]).toEqual(paintOpacity(0.5));
    const after =
      fake.state.counts.setPaintPropertyByName.get(`${PAINT_LAYER_ID}:fill-opacity`) ?? 0;
    expect(after - before).toBeLessThanOrEqual(2);
  });

  it("swaps to the dark palette at night", async () => {
    render(<MapDetailsLayer />);
    await activate();
    act(() => useSceneLightStore.setState({ light: NIGHT_SCENE_LIGHT }));
    await flush();
    const colour = fake.state.paint.get(PAINT_LAYER_ID)?.["fill-color"] as unknown[];
    expect(colour[colour.indexOf("surface") + 1]).toBe(PAINT_PALETTE.dark.surface);
  });

  it("re-adds the source and layer exactly once after a style swap", async () => {
    render(<MapDetailsLayer />);
    await activate();
    const added = fake.state.counts.addLayer.get(PAINT_LAYER_ID) ?? 0;
    act(() => fake.map.setStyle({ version: 8, sources: {}, layers: [] }));
    await flush();
    expect(fake.state.sources.has(PAINT_SOURCE_ID)).toBe(true);
    expect(fake.state.counts.addLayer.get(PAINT_LAYER_ID)).toBe(added + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("credits OpenStreetMap for the rendered paint", async () => {
    render(<MapDetailsLayer />);
    await activate();
    const call = lastAttribution();
    expect(call?.layers).toEqual([PAINT_LAYER_ID]);
    expect(call?.visible).toBe(true);
    const contributors = (
      call?.options as { layerContributors: Record<string, Array<{ sourceId: string }>> }
    ).layerContributors[PAINT_LAYER_ID];
    expect(contributors?.map((c) => c.sourceId)).toEqual(["osm-street-detail"]);
  });

  it("removes its layer, source and worker when unmounted", async () => {
    const view = render(<MapDetailsLayer />);
    await activate();
    view.unmount();
    expect(fake.state.layers.has(PAINT_LAYER_ID)).toBe(false);
    expect(fake.state.sources.has(PAINT_SOURCE_ID)).toBe(false);
    expect(workers.disposed).toBe(1);
  });
});

describe("basemap adjustments", () => {
  it("retints woods while active and restores them after", async () => {
    fake.map.addLayer({
      id: "landcover-wood",
      type: "fill",
      paint: { "fill-color": "#b3efcb", "fill-opacity": 0.5 },
    } as never);
    fake.map.addLayer({
      id: "road_oneway",
      type: "symbol",
      paint: { "icon-opacity": 0.5 },
    } as never);
    render(<MapDetailsLayer />);
    await activate();
    expect(Array.isArray(fake.state.paint.get("landcover-wood")?.["fill-color"])).toBe(true);
    expect(Array.isArray(fake.state.paint.get("road_oneway")?.["icon-opacity"])).toBe(true);
    act(() => buildings.setState({ panelOpen: false, layerVisible: false }));
    await flush();
    expect(fake.state.paint.get("landcover-wood")?.["fill-color"]).toBe("#b3efcb");
    expect(fake.state.paint.get("road_oneway")?.["icon-opacity"]).toBe(0.5);
  });
});
