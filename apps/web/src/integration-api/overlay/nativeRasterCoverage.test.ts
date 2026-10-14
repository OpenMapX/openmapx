import { expect, it } from "vitest";
import { exposedRegions, projectTileFootprint } from "./nativeRasterCoverage";

it("preserves disconnected exposure without querying an opaque hole", () => {
  const regions = exposedRegions(100, 100, [
    [
      [
        [25, 25],
        [75, 25],
        [75, 75],
        [25, 75],
        [25, 25],
      ],
    ],
  ]);
  expect(regions.length).toBeGreaterThan(1);
  const area = regions.reduce(
    (sum, ring) =>
      sum +
      Math.abs(
        ring.reduce((a, p, i) => {
          const q = ring[(i + 1) % ring.length];
          return a + p[0] * q[1] - q[0] * p[1];
        }, 0),
      ) /
        2,
    0,
  );
  expect(area).toBeCloseTo(7500);
});
it("clips actual wrapped/pitched quad matrix at homogeneous frustum", () => {
  const m = [2 / 8192, 0, 0, 0, 0, 2 / 8192, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1];
  expect(projectTileFootprint(m, 100, 100)).toEqual([
    [0, 100],
    [100, 100],
    [100, 0],
    [0, 0],
    [0, 100],
  ]);
  expect(
    projectTileFootprint(
      m.map(() => NaN),
      100,
      100,
    ),
  ).toBeUndefined();
});

import type { Map as MapLibreMap } from "maplibre-gl";
import { vi } from "vitest";
import { nativeRasterCoverage } from "./nativeRasterCoverage";

vi.mock("./rasterMapContribution", () => ({
  retainedRasterOpacity: (_map: unknown, _source: unknown, tile: { opaque: boolean }) =>
    tile.opaque ? "opaque" : "unknown",
}));
function coverageFixture() {
  const coordinates = [
    {
      key: "left",
      overscaledZ: 2,
      wrap: 0,
      canonical: { z: 1, x: 0, y: 0 },
      scaledTo: () => ({ wrap: 0 }),
    },
    {
      key: "right",
      overscaledZ: 2,
      wrap: 0,
      canonical: { z: 1, x: 1, y: 0 },
      scaledTo: () => ({ wrap: 0 }),
    },
  ];
  const tiles = new Map(
    coordinates.map((c) => [
      c.key,
      {
        hasData: () => true,
        texture: {},
        opaque: true,
        fadeOpacity: 1,
        selfFading: false,
        fadingParentID: undefined as { key: string } | undefined,
      },
    ]),
  );
  const matrix = (key: string) => [
    1 / 8192,
    0,
    0,
    0,
    0,
    2 / 8192,
    0,
    0,
    0,
    0,
    1,
    0,
    key === "left" ? -1 : 0,
    -1,
    0,
    1,
  ];
  let opacity = 1;
  let fade = 300;
  const layers = [
    { id: "land", type: "fill", source: "native" },
    { id: "raster", type: "raster", source: "raster" },
    { id: "label", type: "symbol", source: "native" },
  ];
  const frame = {
    terrain: null as object | null,
    data: { moving: false, useSubdivision: false },
    transform: { width: 100, height: 100 },
    getProjectionDataForTile: (c: { key: string }) => ({
      projectionTransition: 1,
      mainMatrix: c.key
        ? matrix(c.key)
        : [2 / 8192, 0, 0, 0, 0, 4 / 8192, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1],
    }),
  };
  const map = {
    getZoom: () => 10,
    getLayoutProperty: () => undefined,
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getStyle: () => ({ layers }),
    painter: { frameRenderContext: frame },
    style: {
      getLayer: () => ({
        type: "raster",
        paint: { get: (name: string) => (name === "raster-opacity" ? opacity : fade) },
      }),
      tileManagers: {
        raster: {
          getSource: () => ({ type: "raster" }),
          getVisibleCoordinates: () => coordinates,
          getTile: (c: { key: string }) => tiles.get(c.key),
          getLoadedTile: (c: { key: string }) => tiles.get(c.key),
        },
      },
    },
  } as unknown as MapLibreMap;
  return {
    map,
    tiles,
    coordinates,
    frame,
    setFade: (n: number) => {
      fade = n;
    },
    setOpacity: (n: number) => {
      opacity = n;
    },
  };
}
it("uses complete retained opaque coverage, leaving native labels above it untouched", () => {
  const f = coverageFixture();
  expect(nativeRasterCoverage(f.map, ["land", "label"]).regions.get("land")).toEqual([]);
  expect(nativeRasterCoverage(f.map, ["land", "label"]).regions.get("label")).toBeUndefined();
  f.setOpacity(0.95);
  expect(nativeRasterCoverage(f.map, ["land"]).regions.get("land")).toBeUndefined();
});
it("failed first loads and partial/transparent/self-fading tiles leave exposed regions", () => {
  const f = coverageFixture();
  f.tiles.get("right")!.opaque = false;
  const ring = nativeRasterCoverage(f.map, ["land"]).regions.get("land")!;
  expect(ring).toHaveLength(1);
  expect(ring[0].every((p) => p[0] >= 50)).toBe(true);
  f.tiles.get("left")!.selfFading = true;
  f.tiles.get("left")!.fadeOpacity = 0.5;
  expect(nativeRasterCoverage(f.map, ["land"]).regions.get("land")).toBeUndefined();
});
it("crossfade requires opaque parent and child in the child footprint; zero-duration ignores the parent", () => {
  const f = coverageFixture();
  f.tiles.get("left")!.fadingParentID = { key: "right" };
  f.tiles.get("left")!.fadeOpacity = 0.5;
  expect(nativeRasterCoverage(f.map, ["land"]).regions.get("land")).toEqual([]);
  f.tiles.get("right")!.opaque = false;
  expect(nativeRasterCoverage(f.map, ["land"]).regions.get("land")).toBeUndefined();
  f.setFade(0);
  expect(nativeRasterCoverage(f.map, ["land"]).regions.get("land")).toHaveLength(1);
});
it("actual terrain returns unknown coverage and stable globe supplies tile masks", () => {
  const f = coverageFixture();
  f.frame.terrain = {};
  expect(nativeRasterCoverage(f.map, ["land"])).toMatchObject({ limitation: "terrain-raster" });
  expect(nativeRasterCoverage(f.map, ["land"]).regions.get("land")).toBeUndefined();
  f.frame.terrain = null;
  expect(nativeRasterCoverage(f.map, ["land"]).regions.get("land")).toEqual([]);
  f.frame.data.useSubdivision = true;
  expect(nativeRasterCoverage(f.map, ["land"]).globeMasks?.get("land")?.length).toBeGreaterThan(0);
});

it("keeps stable zoom blends supported and invalid projection frames unknown", () => {
  const f = coverageFixture();
  f.frame.data.useSubdivision = true;
  const projection = f.frame.getProjectionDataForTile;
  f.frame.getProjectionDataForTile = (c) => ({ ...projection(c), projectionTransition: 0.5 });
  const transition = nativeRasterCoverage(f.map, ["land"]);
  expect(transition.limitation).toBeUndefined();
  expect(transition.globeMasks?.get("land")?.length).toBeGreaterThan(0);
  f.frame.getProjectionDataForTile = (c) => ({ ...projection(c), projectionTransition: NaN });
  expect(nativeRasterCoverage(f.map, ["land"]).limitation).toBe("invalid-projection");
  f.frame.getProjectionDataForTile = projection;
  expect(nativeRasterCoverage(f.map, ["land"]).globeMasks?.get("land")?.length).toBeGreaterThan(0);
});
it("preserves actual raster world copies during a stable blend without inventing neighboring coverage", () => {
  const f = coverageFixture();
  f.frame.data.useSubdivision = true;
  f.coordinates.forEach((c) => {
    c.wrap = 2;
  });
  const mask = nativeRasterCoverage(f.map, ["land"]).globeMasks?.get("land");
  expect(mask?.flat(2).every((p) => p[0] >= 2 && p[0] <= 3)).toBe(true);
});
