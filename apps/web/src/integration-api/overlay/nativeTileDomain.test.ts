import { createTileMesh, type Map as MapLibreMap } from "maplibre-gl";
import { expect, it, vi } from "vitest";
import frames from "./fixtures/globe-native-frames.json";
import { projectGlobeVertex, readNativeMesh, visibleNativeTileDomain } from "./nativeTileDomain";
import { nativeStencilOwnership, worldToTile } from "./nativeTileQuery";

type Frame = MapLibreMap["painter"]["frameRenderContext"];
function meshFixture(
  north = false,
  south = false,
  captured?: { vertices: ArrayBuffer; indices: ArrayBuffer },
) {
  const data =
    captured ??
    createTileMesh(
      {
        granularity: 32,
        generateBorders: true,
        extendToNorthPole: north,
        extendToSouthPole: south,
      },
      "16bit",
    );
  const previous = { name: "caller binding" },
    vertex = { name: "vertex" },
    index = { name: "index" };
  let binding: object | null = previous;
  const gl = {
    COPY_READ_BUFFER: 1,
    COPY_READ_BUFFER_BINDING: 2,
    BUFFER_SIZE: 3,
    isContextLost: () => false,
    getParameter: () => binding,
    bindBuffer: vi.fn((_target: unknown, value: unknown) => {
      binding = value as object | null;
    }),
    getBufferParameter: () =>
      binding === vertex ? data.vertices.byteLength : data.indices.byteLength,
    getBufferSubData: vi.fn((_target: unknown, _offset: unknown, out: unknown) => {
      (out as Uint16Array).set(new Uint16Array(binding === vertex ? data.vertices : data.indices));
    }),
  };
  const mesh = {
    vertexBuffer: {
      context: { gl },
      itemSize: 4,
      dynamicDraw: false,
      length: data.vertices.byteLength / 4,
      buffer: vertex,
    },
    indexBuffer: { dynamicDraw: false, buffer: index },
  } as unknown as ReturnType<Frame["getMeshFromTileID"]>;
  return { mesh, gl, previous };
}
it("reads immutable mesh bytes once and restores only COPY_READ_BUFFER even when readback fails", () => {
  const f = meshFixture();
  const bytes = readNativeMesh(f.mesh);
  expect(bytes?.vertices.length).toBeGreaterThan(0);
  expect(f.gl.getParameter()).toBe(f.previous);
  expect(f.gl.getBufferSubData).toHaveBeenCalledTimes(2);
  expect(readNativeMesh(f.mesh)).toBe(bytes);
  expect(f.gl.getBufferSubData).toHaveBeenCalledTimes(2);
  const failed = meshFixture();
  failed.gl.getBufferSubData.mockImplementation(() => {
    throw new Error("lost");
  });
  expect(readNativeMesh(failed.mesh)).toBeUndefined();
  expect(failed.gl.getParameter()).toBe(failed.previous);
});
it.each(frames)(
  "clips captured globe front/horizon and pole mesh in native tile coordinates ($north,$south)",
  (fixture) => {
    const { mesh } = meshFixture(fixture.north, fixture.south);
    const frame = {
      transform: { width: 2560, height: 1167 },
      getProjectionDataForTile: () => fixture.projection,
      getMeshFromTileID: () => mesh,
    } as unknown as Frame;
    const result = visibleNativeTileDomain(
      frame,
      fixture.coordinate as Parameters<Frame["getProjectionDataForTile"]>[0],
    );
    expect(result?.length).toBeGreaterThan(0);
    expect(result?.flat(2).every((p) => p.every(Number.isFinite))).toBe(true);
    expect(result?.flat(2).some((p) => p[0] > 0 && p[0] < 8192)).toBe(true);
    const opaque: MultiPolygon = [
      [
        [
          [-64, -32768],
          [4096, -32768],
          [4096, 32767],
          [-64, 32767],
          [-64, -32768],
        ],
      ],
    ];
    const pruned = visibleNativeTileDomain(
      frame,
      fixture.coordinate as Parameters<Frame["getProjectionDataForTile"]>[0],
      false,
      opaque,
    );
    expect(pruned).toBeDefined();
    if (result && pruned) {
      const fullExposure = difference(result, opaque),
        fastExposure = difference(pruned, opaque);
      expect(difference(fullExposure, fastExposure)).toEqual([]);
      expect(difference(fastExposure, fullExposure)).toEqual([]);
    }

    const transition = {
      ...frame,
      getProjectionDataForTile: () => ({ ...fixture.projection, projectionTransition: NaN }),
    } as unknown as Frame;
    expect(
      visibleNativeTileDomain(
        transition,
        fixture.coordinate as Parameters<Frame["getProjectionDataForTile"]>[0],
      ),
    ).toBeUndefined();
  },
);
it("projects actual pole sentinel to the pole independent of its nominal longitude", () => {
  const p = frames[0].projection as unknown as Parameters<typeof projectGlobeVertex>[2];
  expect(projectGlobeVertex(0, -32768, p).slice(0, 4)).toEqual(
    projectGlobeVertex(8192, -32768, p).slice(0, 4),
  );
  expect(projectGlobeVertex(0, 32767, p).slice(0, 4)).toEqual(
    projectGlobeVertex(8192, 32767, p).slice(0, 4),
  );
});
it("gives neighbor interiors priority over native border and retained parent interiors", () => {
  const coord = (z: number, x: number, y: number) =>
    ({ wrap: 0, canonical: { z, x, y } }) as Parameters<typeof nativeStencilOwnership>[0];
  const left = coord(1, 0, 0),
    right = coord(1, 1, 0);
  const owned = nativeStencilOwnership(left, [left, right]);
  expect(owned.flat(2).every((p) => p[0] <= 8192)).toBe(true);
  const parent = coord(0, 0, 0),
    child = coord(1, 0, 0);
  const parentOwned = nativeStencilOwnership(parent, [parent, child]);
  expect(parentOwned.flat(2).some((p) => p[0] === 4096)).toBe(true);
  expect(
    worldToTile(
      [
        [
          [
            [0, 0],
            [0.5, 0],
            [0.5, 0.5],
            [0, 0.5],
            [0, 0],
          ],
        ],
      ],
      left,
    ),
  ).toEqual([
    [
      [
        [0, 0],
        [8192, 0],
        [8192, 8192],
        [0, 8192],
        [0, 0],
      ],
    ],
  ]);
});

it("matches the shader blended x/y/w, delayed horizon Z, and pole hiding equations", () => {
  const base = frames[0].projection as unknown as Parameters<typeof projectGlobeVertex>[2];
  const p = {
    ...base,
    mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    fallbackMatrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 1,
  } as typeof base;
  const full = projectGlobeVertex(100, 200, p);
  for (const blend of [0.001, 0.25, 0.5, 0.75, 0.999]) {
    const actual = projectGlobeVertex(100, 200, { ...p, projectionTransition: blend });
    expect(actual[0]).toBeCloseTo(210 * (1 - blend) + full[0] * blend);
    expect(actual[1]).toBeCloseTo(420 * (1 - blend) + full[1] * blend);
    expect(actual[2]).toBeCloseTo(Math.max(0, (blend - 0.2) / 0.8));
    expect(actual[3]).toBe(1);
  }
  const hidden = projectGlobeVertex(100, -32768, { ...p, projectionTransition: 0.5 });
  expect(hidden[2]).toBeGreaterThan(hidden[3]); // clipped behind far plane
});
it("keeps stencil ownership in the actual retained wrapped world during stable projection blends", () => {
  const c = { wrap: 1, canonical: { z: 10, x: 0, y: 654 } } as Parameters<
    typeof nativeStencilOwnership
  >[0];
  const domain = nativeStencilOwnership(c, [c]);
  expect(Math.min(...domain.flat(2).map((p) => p[0]))).toBe(-64);
  expect(Math.max(...domain.flat(2).map((p) => p[0]))).toBe(8256);
});

import { difference, intersection } from "polyclip-ts";
import wrappedFrame from "./fixtures/globe-wrapped-blend.json";
import type { MultiPolygon } from "./nativeRasterCoverage";

it("retains real native geometry at the captured pitched wrapped blend boundary without a synthetic band", () => {
  const coordinates = wrappedFrame.coordinates as unknown as Parameters<
    typeof nativeStencilOwnership
  >[1];
  let positives = 0;
  for (let i = 0; i < coordinates.length; i++) {
    const capture = wrappedFrame.tiles[i],
      coord = coordinates[i];
    const data = {
      vertices: new Int16Array(capture.vertices).buffer,
      indices: new Uint16Array(capture.indices).buffer,
    };
    const { mesh } = meshFixture(false, false, data);
    const frame = {
      getProjectionDataForTile: () => capture.projection,
      getMeshFromTileID: () => mesh,
    } as unknown as Frame;
    const owned = nativeStencilOwnership(coord, coordinates);
    const exposed = difference(owned, worldToTile(wrappedFrame.mask as MultiPolygon, coord));
    const visible = visibleNativeTileDomain(frame, coord);
    expect(visible).toBeDefined();
    const feature: MultiPolygon = [
      [
        [
          [200, 200],
          [7992, 200],
          [7992, 7992],
          [200, 7992],
          [200, 200],
        ],
      ],
    ];
    if (visible && intersection(exposed, visible, feature).length) positives++;
  }
  expect(positives).toBeGreaterThan(0);
});
