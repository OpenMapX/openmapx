import { MercatorCoordinate } from "maplibre-gl";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state = { fail: false, renderers: [] as FakeRenderer[] };
  class FakeRenderer {
    autoClear = true;
    localClippingEnabled = false;
    resetState = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
    constructor() {
      if (state.fail) throw new Error("WebGL unavailable");
      state.renderers.push(this);
    }
  }
  return { state, FakeRenderer };
});
type FakeRenderer = InstanceType<typeof fake.FakeRenderer>;
const renderers = fake.state.renderers;

vi.mock("three", async (original) => ({
  ...(await original<typeof import("three")>()),
  WebGLRenderer: fake.FakeRenderer,
}));

import { LandmarkModelLayer, type PlacedModel } from "../web/model-layer";
import type { LoadedModel } from "../web/models";

const ANCHOR: [number, number] = [2.2945, 48.8584];
const anchorMerc = MercatorCoordinate.fromLngLat(ANCHOR);
const METRE = anchorMerc.meterInMercatorCoordinateUnits();

/** Affine camera: 100 m around the anchor fill the viewport, heights well inside clip z. */
function mainMatrix(): number[] {
  const s = 1 / (100 * METRE);
  return [s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s * 0.001, 0, -anchorMerc.x * s, anchorMerc.y * s, 0, 1];
}

function fakeMap() {
  return {
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLCanvasElement,
    getCenter: () => ({ lng: ANCHOR[0], lat: ANCHOR[1] }),
    triggerRepaint: vi.fn(),
  } as never;
}

function placed(assetId: string, lngLat: [number, number] = ANCHOR): PlacedModel {
  const scene = new Group();
  scene.add(new Mesh(new BoxGeometry(10, 10, 10), new MeshStandardMaterial()));
  const model: LoadedModel = {
    key: `${assetId}|low`,
    scene,
    positions: new Float32Array(),
    bytesEstimate: 0,
    dispose: vi.fn(),
    setNight: vi.fn(),
  };
  return {
    assetId,
    model,
    anchor: lngLat,
    groundM: 0,
    elevationM: 0,
    clipBelowGround: false,
    receipts: [],
  };
}

function renderArgs(projectionTransition = 0) {
  return { defaultProjectionData: { mainMatrix: mainMatrix(), projectionTransition } } as never;
}

afterEach(() => {
  renderers.length = 0;
  fake.state.fail = false;
});

describe("LandmarkModelLayer", () => {
  it("object matrices never flip the front face", () => {
    const layer = new LandmarkModelLayer({ onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    const model = placed("a");
    layer.setPlaced([model]);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(model.model.scene.matrixWorld.determinant()).toBeGreaterThan(0);
  });

  it("onAdd twice disposes the first renderer", () => {
    const layer = new LandmarkModelLayer({ onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    expect(renderers).toHaveLength(2);
    expect(renderers[0]?.dispose).toHaveBeenCalled();
    expect(renderers[1]?.autoClear).toBe(false);
    expect(renderers[1]?.localClippingEnabled).toBe(true);
  });

  it("render resets GL state before and after drawing", () => {
    const layer = new LandmarkModelLayer({ onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.setPlaced([placed("a")]);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    const renderer = renderers[0] as FakeRenderer;
    const order = [
      ...renderer.resetState.mock.invocationCallOrder,
      ...renderer.render.mock.invocationCallOrder,
    ].sort((a, b) => a - b);
    expect(order).toEqual([
      renderer.resetState.mock.invocationCallOrder[0],
      renderer.render.mock.invocationCallOrder[0],
      renderer.resetState.mock.invocationCallOrder[1],
    ]);
  });

  it("skips frames while the globe transition is active", () => {
    const layer = new LandmarkModelLayer({ onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.setPlaced([placed("a")]);
    layer.render({} as WebGL2RenderingContext, renderArgs(0.5));
    expect(renderers[0]?.render).not.toHaveBeenCalled();
    expect(layer.drawnAssetIds()).toEqual([]);
  });

  it("reports frustum-intersecting asset ids as drawn", () => {
    const onFrame = vi.fn();
    const layer = new LandmarkModelLayer({ onUnsupported: vi.fn(), onFrame });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.setPlaced([placed("near"), placed("far", [2.32, 48.87])]);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(layer.drawnAssetIds()).toEqual(["near"]);
    expect(onFrame).toHaveBeenCalledWith(["near"]);
  });

  it("calls onUnsupported once when the renderer cannot be created", () => {
    fake.state.fail = true;
    const onUnsupported = vi.fn();
    const layer = new LandmarkModelLayer({ onUnsupported });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });

  it("pick returns the asset under the point", () => {
    const layer = new LandmarkModelLayer({ onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.setPlaced([placed("tower")]);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(layer.pick({ x: 400, y: 300 })).toBe("tower");
    expect(layer.pick({ x: 5, y: 5 })).toBeNull();
  });

  it("setNight switches every placed model", () => {
    const layer = new LandmarkModelLayer({ onUnsupported: vi.fn() });
    const model = placed("a");
    layer.setPlaced([model]);
    layer.setNight(true);
    expect(model.model.setNight).toHaveBeenCalledWith(true);
  });
});
