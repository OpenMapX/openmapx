import type { Map as MapLibreMap } from "maplibre-gl";
import { expect, it, vi } from "vitest";
import type { MultiPolygon } from "./nativeRasterCoverage";
import { queryNativeScreenDomains, queryNativeTileDomains } from "./nativeTileQuery";

const domain = vi.hoisted(() => vi.fn());
vi.mock("./nativeTileDomain", () => ({ visibleNativeTileDomain: domain }));
const mask: MultiPolygon = [
  [
    [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
      [0, 0],
    ],
  ],
];
const rect = (x0: number, x1: number): MultiPolygon => [
  [
    [
      [x0, 0],
      [x1, 0],
      [x1, 8192],
      [x0, 8192],
      [x0, 0],
    ],
  ],
];
function fixture() {
  const coord = { canonical: { z: 0, x: 0, y: 0 }, wrap: 0, overscaledZ: 0 };
  const query = vi.fn(() => ({}));
  const layer = { id: "land", type: "fill", source: "data", "source-layer": "fixture" };
  const tile = {
    hasData: () => true,
    holdingForSymbolFade: () => false,
    queryRenderedFeatures: query,
  };
  const state = { selected: true };
  const map = {
    painter: {
      frameRenderContext: {
        transform: { zoom: 0, width: 100, height: 100, maxPitchScaleFactor: () => 1 },
      },
    },
    style: {
      getLayer: () => layer,
      tileManagers: {
        data: {
          getVisibleCoordinates: () => [coord],
          getTile: () => tile,
          getState: () => ({}),
          getFeatureState: () => state,
        },
      },
    },
    getStyle: () => ({ layers: [layer] }),
    listImages: () => [],
  } as unknown as MapLibreMap;
  return { map, query, state, layer };
}
it("uses negative-only candidate preflight without mesh readback or positive receipts", () => {
  const f = fixture(),
    accept = vi.fn();
  domain.mockClear();
  expect(queryNativeTileDomains(f.map, ["land"], mask, accept, () => false)).toBe(true);
  expect(f.query).toHaveBeenCalled();
  expect(domain).not.toHaveBeenCalled();
  expect(accept).not.toHaveBeenCalled();
});
it("never publishes preflight hits outside the real native visible domain", () => {
  const f = fixture(),
    accept = vi.fn();
  f.query.mockReturnValue({ land: [{ feature: { id: 1, layer: f.layer } }] });
  domain.mockReturnValue([]);
  expect(queryNativeTileDomains(f.map, ["land"], mask, accept, () => false)).toBe(true);
  expect(accept).not.toHaveBeenCalled();
});
it("preserves source-layer and feature state on positive clipped engine evidence", () => {
  const f = fixture(),
    accept = vi.fn();
  f.query.mockReturnValue({ land: [{ feature: { id: 1, layer: f.layer } }] });
  domain.mockReturnValue(rect(0, 8192));
  expect(queryNativeTileDomains(f.map, ["land"], mask, accept, () => false)).toBe(true);
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ source: "data", sourceLayer: "fixture", state: f.state }),
  );
});

it("stops the unmasked engine tile query as soon as its receipts are proven", () => {
  const f = fixture();
  const manager = f.map.style.tileManagers.data;
  const geometry = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ];
  const tile = { queryRenderedFeatures: f.query };
  Object.assign(manager, {
    tilesIn: () => [
      { tile, tileID: {}, queryGeometry: geometry, cameraQueryGeometry: geometry, scale: 2 },
      { tile, tileID: {}, queryGeometry: geometry, cameraQueryGeometry: geometry, scale: 2 },
    ],
  });
  Object.assign(f.map.painter.frameRenderContext.transform, {
    getFastPathSimpleProjectionMatrix: () => undefined,
  });
  f.query.mockReturnValue({ land: [{ feature: { id: 1, layer: f.layer } }] });
  let proven = false;
  expect(
    queryNativeScreenDomains(
      f.map,
      ["land"],
      undefined,
      () => {
        proven = true;
      },
      () => proven,
    ),
  ).toBe(true);
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls[0]?.slice(3, 6)).toEqual([geometry, geometry, 2]);
});
