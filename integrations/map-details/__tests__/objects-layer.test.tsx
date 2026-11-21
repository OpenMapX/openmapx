import { Color, type InstancedMesh } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_STRIDE, type ModelKind } from "../web/derive/forest";
import { EARTH_CIRCUMFERENCE_M, tileCentreLat } from "../web/derive/units";
import type { Selection } from "../web/selection";

const fake = vi.hoisted(() => {
  const state = { fail: false, renderers: [] as FakeRenderer[], calls: [] as string[] };
  class FakeRenderer {
    autoClear = true;
    resetState = vi.fn(() => state.calls.push("reset"));
    render = vi.fn(() => state.calls.push("render"));
    dispose = vi.fn();
    private readonly context: unknown;
    constructor(parameters: { context?: unknown } = {}) {
      if (state.fail) throw new Error("WebGL unavailable");
      this.context = parameters.context;
      state.renderers.push(this);
    }
    getContext() {
      return this.context;
    }
  }
  return { state, FakeRenderer };
});
type FakeRenderer = InstanceType<typeof fake.FakeRenderer>;

vi.mock("three", async (original) => ({
  ...(await original<typeof import("three")>()),
  WebGLRenderer: fake.FakeRenderer,
}));

import { ROLE_COLOURS } from "../web/models";
import {
  MapDetailsObjectsLayer,
  OBJECTS_LAYER_ID,
  type ObjectLighting,
} from "../web/objects-layer";
import { createMapDetailsScene } from "../web/scene";

const CELL = { key: "35209/21492", x: 35209, y: 21492 };
const N = 2 ** 16;
const ORIGIN: [number, number] = [
  ((CELL.x + 0.5) / N) * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * (CELL.y + 0.5)) / N))) * 180) / Math.PI,
];
const SIZE = (EARTH_CIRCUMFERENCE_M * Math.cos((tileCentreLat(16, CELL.y) * Math.PI) / 180)) / N;
const LIGHT: ObjectLighting = {
  direction: [0.3, -0.4, 0.8],
  color: "#ffffff",
  intensity: 1,
  ambientColor: "#ffffff",
  ambientIntensity: 0.1,
  night: false,
};

function selected(
  kind: ModelKind,
  rows: Array<[number, number, number]>,
): Selection["near"][number] {
  const data = new Float32Array(rows.length * INSTANCE_STRIDE);
  for (const [i, [x, y, mapped]] of rows.entries())
    data.set([x, y, 0, 10, 6, 0, 0.05, mapped], i * INSTANCE_STRIDE);
  return { kind, count: rows.length, data, cell: new Uint16Array(rows.length) };
}
function selection(...near: Selection["near"]): Selection {
  return { near, far: [], cells: [CELL] };
}

function fakeMap() {
  return {
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLCanvasElement,
    triggerRepaint: vi.fn(),
  };
}
const renderArgs = (projectionTransition = 0) =>
  ({
    defaultProjectionData: {
      mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      projectionTransition,
    },
  }) as never;

function setup() {
  const onUnsupported = vi.fn();
  const layer = new MapDetailsObjectsLayer({ lighting: LIGHT, onUnsupported });
  const map = fakeMap();
  const gl = {} as WebGL2RenderingContext;
  layer.onAdd(map as never, gl);
  return { layer, map, gl, onUnsupported };
}
const mesh = (layer: MapDetailsObjectsLayer, key: string) =>
  layer.instancedMeshes().get(key) as InstancedMesh;
const zOf = (m: InstancedMesh, i: number) => m.instanceMatrix.array[i * 16 + 14] as number;

afterEach(() => {
  fake.state.renderers.length = 0;
  fake.state.calls.length = 0;
  fake.state.fail = false;
});

describe("MapDetailsObjectsLayer", () => {
  it("is a 3D custom layer with a fixed id", () => {
    const { layer } = setup();
    expect(layer).toMatchObject({ id: OBJECTS_LAYER_ID, type: "custom", renderingMode: "3d" });
    expect(OBJECTS_LAYER_ID).toBe("openmapx-map-details-objects");
  });

  it("reuses its renderer for the same context and makes a new one for a new context", () => {
    const { layer, map, gl } = setup();
    layer.onAdd(map as never, gl);
    expect(fake.state.renderers).toHaveLength(1);
    layer.onAdd(map as never, {} as WebGL2RenderingContext);
    expect(fake.state.renderers).toHaveLength(2);
    expect(fake.state.renderers[0]?.dispose).toHaveBeenCalled();
    expect(fake.state.renderers[1]?.autoClear).toBe(false);
  });

  it("resets GL state around each draw and never asks for a repaint from render", () => {
    const { layer, map, gl } = setup();
    layer.setInstances(selection(selected("broadleaf", [[10, 10, 0]])), ORIGIN);
    map.triggerRepaint.mockClear();
    layer.render(gl, renderArgs());
    expect(fake.state.calls).toEqual(["reset", "render", "reset"]);
    expect(map.triggerRepaint).not.toHaveBeenCalled();
  });

  it("skips frames during the globe transition", () => {
    const { layer, gl } = setup();
    layer.render(gl, renderArgs(0.5));
    expect(fake.state.calls).toEqual([]);
  });

  it("repaints only when instances, lighting, satellite or terrain change", () => {
    const { layer, map } = setup();
    layer.setLighting(LIGHT);
    expect(map.triggerRepaint).not.toHaveBeenCalled();
    layer.setInstances(selection(selected("broadleaf", [[10, 10, 0]])), ORIGIN);
    layer.setLighting({ ...LIGHT, intensity: 0.5 });
    layer.setSatellite(true);
    layer.setSatellite(true);
    layer.setTerrain(CELL.key, null);
    layer.setTerrain(CELL.key, new Float32Array(81));
    expect(map.triggerRepaint).toHaveBeenCalledTimes(4);
  });

  it("draws the contact discs before the trees", () => {
    const { layer } = setup();
    layer.setInstances(selection(selected("broadleaf", [[10, 10, 0]])), ORIGIN);
    const shadows = layer.shadowMesh();
    expect(shadows.count).toBe(1);
    expect(shadows.renderOrder).toBeLessThan(mesh(layer, "broadleaf|near").renderOrder);
  });

  it("hides a cell while its terrain loads and grounds it on the sampled grid", () => {
    const { layer } = setup();
    layer.setInstances(selection(selected("broadleaf", [[SIZE / 2, SIZE / 2, 0]])), ORIGIN);
    expect(mesh(layer, "broadleaf|near").count).toBe(1);
    expect(zOf(mesh(layer, "broadleaf|near"), 0)).toBeCloseTo(0, 6);
    layer.setTerrain(CELL.key, "pending");
    expect(mesh(layer, "broadleaf|near").count).toBe(0);
    // A 9 × 9 grid rising 10 m per row northwards: the cell centre sits at 40 m.
    const grid = new Float32Array(81).map((_, i) => Math.floor(i / 9) * 10);
    layer.setTerrain(CELL.key, grid);
    expect(mesh(layer, "broadleaf|near").count).toBe(1);
    expect(zOf(mesh(layer, "broadleaf|near"), 0)).toBeCloseTo(40, 1);
  });

  it("hides only planted trees on satellite imagery", () => {
    const { layer } = setup();
    layer.setInstances(
      selection(
        selected("broadleaf", [
          [10, 10, 0],
          [20, 20, 1],
        ]),
      ),
      ORIGIN,
    );
    expect(mesh(layer, "broadleaf|near").count).toBe(2);
    layer.setSatellite(true);
    expect(mesh(layer, "broadleaf|near").count).toBe(1);
  });

  it("switches to the night palette with an ambient floor", () => {
    const { layer } = setup();
    layer.setInstances(selection(selected("signal", [[10, 10, 1]])), ORIGIN);
    layer.setLighting({ ...LIGHT, night: true, ambientIntensity: 0.01 });
    const geometry = mesh(layer, "signal|near").geometry;
    const role = geometry.getAttribute("role");
    const colour = geometry.getAttribute("color");
    const lens = Array.from({ length: role.count }, (_, i) => i).find(
      (i) => role.getX(i) === 4,
    ) as number;
    const warm = new Color(ROLE_COLOURS.night.lens);
    expect(colour.getX(lens)).toBeCloseTo(warm.r, 5);
    expect(layer.ambientIntensity()).toBeGreaterThanOrEqual(0.3);
  });

  it("reports an unsupported context once", () => {
    fake.state.fail = true;
    const onUnsupported = vi.fn();
    const layer = new MapDetailsObjectsLayer({ lighting: LIGHT, onUnsupported });
    layer.onAdd(fakeMap() as never, {} as WebGL2RenderingContext);
    layer.onAdd(fakeMap() as never, {} as WebGL2RenderingContext);
    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });

  it("is created by the scene module", () => {
    const { layer } = createMapDetailsScene({ lighting: LIGHT, onUnsupported: vi.fn() });
    expect(layer).toBeInstanceOf(MapDetailsObjectsLayer);
  });
});
