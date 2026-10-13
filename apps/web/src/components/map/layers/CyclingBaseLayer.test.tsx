import { useLayerStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import type { AddProtocolAction, RasterTileSource } from "maplibre-gl";
import { afterEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { attributedRasterRequestTransform } from "@/integration-api/overlay/rasterResponseProtocol";
import { createFakeMap } from "@/test";
import { CyclingBaseLayer } from "./CyclingBaseLayer";

const fake = createFakeMap();
let protocol: AddProtocolAction;
vi.mock("maplibre-gl", () => ({
  addProtocol: (_name: string, action: AddProtocolAction) => {
    protocol = action;
  },
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ cyclOsmTileUrlTemplate: "/tiles/cyclosm/{z}/{x}/{y}.png" }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("credits response suppliers with their texture commits, never HEAD or a newest-prop guess", async () => {
  vi.useFakeTimers();
  type Tile = Parameters<RasterTileSource["loadTile"]>[0];
  const tile = {
    state: "loading",
    texture: undefined as object | undefined,
    fadeOpacity: 1,
    hasData() {
      return !!this.texture;
    },
  };
  const acquired: Array<() => void> = [];
  const responses = [
    new Response(new Uint8Array([1]), {
      headers: {
        "X-OpenMapX-Contributors": encodeURIComponent(
          JSON.stringify([
            { sourceId: "thunderforest", name: "Maps © Thunderforest" },
            { sourceId: "openstreetmap", name: "© OpenStreetMap contributors" },
          ]),
        ),
      },
    }),

    new Response(new Uint8Array([2]), {
      headers: {
        "X-OpenMapX-Contributors": encodeURIComponent(
          JSON.stringify([
            { sourceId: "cyclosm", name: "CyclOSM" },
            { sourceId: "openstreetmap", name: "© OpenStreetMap contributors" },
          ]),
        ),
      },
    }),
    new Response(new Uint8Array([3])),
  ];
  const fetchMock = vi.fn(async () => responses.shift());
  vi.stubGlobal("fetch", fetchMock);
  const add = fake.map.addSource;
  fake.map.addSource = (id, spec) => {
    add(id, spec);
    const source = fake.map.getSource<RasterTileSource>(id);
    if (!source || spec.type !== "raster") throw new Error("fixture source");
    source.tiles = spec.tiles ?? [];
    source.loadTile = async function (target) {
      const url = this.tiles[0].replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");
      const params = await attributedRasterRequestTransform()(url);
      if (!params) throw new Error("fixture transform");
      const bytes = await protocol(params, new AbortController());
      // Hold decoding/texture upload after headers + body complete. Another
      // response may decode first, including on a pooled texture object.
      await new Promise<void>((resolve) => acquired.push(resolve));
      target.texture = tile.texture ?? ({} as Tile["texture"]);
      Object.assign(target.texture, { bytes: bytes.data });
      target.state = "loaded";
    };
    return fake.map;
  };
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      tileManagers: {
        "openmapx-cyclosm-source": { getVisibleCoordinates: () => [{}], getTile: () => tile },
      },
      getLayer: () => ({ paint: { get: () => 0.95 } }),
    },
  });
  useMapAttributionStore.setState({ byLayer: {} });
  useLayerStore.getState().setActiveLayer("cycling");
  const view = render(<CyclingBaseLayer />);
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  const html = () => Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
  const source = fake.map.getSource<RasterTileSource>("openmapx-cyclosm-source");
  if (!source) throw new Error("missing source");
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  try {
    expect(fetchMock).not.toHaveBeenCalled();
    const first = source.loadTile(tile as Tile);
    await drain();
    const second = source.loadTile(tile as Tile);
    await drain();
    expect(acquired).toHaveLength(2);
    acquired[1]();
    await second;
    flush();
    expect(html()).toContain("CyclOSM");
    expect(html()).not.toContain("Thunderforest");
    acquired[0]();
    await first;
    flush();
    expect(html()).toContain("Thunderforest");
    expect(html()).not.toContain("CyclOSM");
    expect(html()).toContain("OpenStreetMap");
    const unknown = source.loadTile(tile as Tile);
    await drain();
    acquired[2]();
    await unknown;
    flush();
    expect(html()).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [request] of fetchMock.mock.calls) {
      if (!(request instanceof Request)) throw new Error("Missing request");
      expect(request.method).toBe("GET");
    }
  } finally {
    view.unmount();
    fake.map.addSource = add;
  }
});
