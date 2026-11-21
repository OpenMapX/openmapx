import { MercatorCoordinate } from "maplibre-gl";
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from "three";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { NEUTRAL_SCENE_LIGHT, sunVector } from "@/integration-api/map/sceneLight";

const fake = vi.hoisted(() => {
  const state = { fail: false, renderers: [] as FakeRenderer[] };
  class FakeRenderer {
    autoClear = true;
    localClippingEnabled = false;
    resetState = vi.fn();
    render = vi.fn();
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

/** What the map layer passes for the initial neutral scene light. */
const NEUTRAL_LIGHTING = {
  direction: sunVector(NEUTRAL_SCENE_LIGHT),
  color: NEUTRAL_SCENE_LIGHT.sunColor,
  intensity: NEUTRAL_SCENE_LIGHT.sunIntensity,
  ambientColor: NEUTRAL_SCENE_LIGHT.ambientColor,
  ambientIntensity: NEUTRAL_SCENE_LIGHT.ambientIntensity,
};

function lightsOf(layer: LandmarkModelLayer) {
  const children = (layer as unknown as { scene: Scene }).scene.children;
  const sun = children.find((child) => child instanceof DirectionalLight);
  const ambient = children.find((child) => child instanceof AmbientLight);
  assert.isDefined(sun, "the scene has a sun light");
  assert.isDefined(ambient, "the scene has an ambient light");
  return { sun, ambient };
}

afterEach(() => {
  renderers.length = 0;
  fake.state.fail = false;
});

describe("LandmarkModelLayer", () => {
  it("object matrices never flip the front face", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    const model = placed("a");
    layer.setPlaced([model]);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(model.model.scene.matrixWorld.determinant()).toBeGreaterThan(0);
  });

  it("onAdd reuses the renderer for the same GL context and replaces it for a new one", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    const gl = {} as WebGL2RenderingContext;
    layer.onAdd(fakeMap(), gl);
    layer.onRemove();
    layer.onAdd(fakeMap(), gl);
    expect(renderers).toHaveLength(1);
    expect(renderers[0]?.dispose).not.toHaveBeenCalled();
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    expect(renderers).toHaveLength(2);
    expect(renderers[0]?.dispose).toHaveBeenCalled();
    expect(renderers[1]?.autoClear).toBe(false);
    expect(renderers[1]?.localClippingEnabled).toBe(true);
    layer.dispose();
    expect(renderers[1]?.dispose).toHaveBeenCalled();
  });

  it("repaints only when the placement changes", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    const map = fakeMap() as { triggerRepaint: ReturnType<typeof vi.fn> };
    layer.onAdd(map as never, {} as WebGL2RenderingContext);
    const model = placed("a");
    layer.setPlaced([model]);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    layer.setPlaced([{ ...model }]);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    layer.setPlaced([{ ...model, groundM: 12 }]);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(2);
    layer.setPlaced([]);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(3);
  });

  it("render resets GL state before and after drawing", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
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
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.setPlaced([placed("a")]);
    layer.render({} as WebGL2RenderingContext, renderArgs(0.5));
    expect(renderers[0]?.render).not.toHaveBeenCalled();
    expect(layer.drawnAssetIds()).toEqual([]);
  });

  it("reports frustum-intersecting asset ids as drawn", () => {
    const onFrame = vi.fn();
    const layer = new LandmarkModelLayer({
      lighting: NEUTRAL_LIGHTING,
      onUnsupported: vi.fn(),
      onFrame,
    });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.setPlaced([placed("near"), placed("far", [2.32, 48.87])]);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(layer.drawnAssetIds()).toEqual(["near"]);
    expect(onFrame).toHaveBeenCalledWith(["near"]);
  });

  it("calls onUnsupported once when the renderer cannot be created", () => {
    fake.state.fail = true;
    const onUnsupported = vi.fn();
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });

  it("pick returns the asset under the point", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    layer.onAdd(fakeMap(), {} as WebGL2RenderingContext);
    layer.setPlaced([placed("tower")]);
    layer.render({} as WebGL2RenderingContext, renderArgs());
    expect(layer.pick({ x: 400, y: 300 })).toBe("tower");
    expect(layer.pick({ x: 5, y: 5 })).toBeNull();
  });

  it("starts from the shared neutral sun", () => {
    const { sun, ambient } = lightsOf(
      new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() }),
    );
    const [x, y, z] = sunVector(NEUTRAL_SCENE_LIGHT);
    expect(sun.position.x).toBeCloseTo(x, 6);
    expect(sun.position.y).toBeCloseTo(y, 6);
    expect(sun.position.z).toBeCloseTo(z, 6);
    expect(sun.color.getHexString()).toBe("fff4df");
    expect(sun.intensity).toBe(2.2);
    expect(ambient.intensity).toBe(1.4);
  });

  it("updates its lights from the scene light and repaints only on change", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    const map = fakeMap() as { triggerRepaint: ReturnType<typeof vi.fn> };
    layer.onAdd(map as never, {} as WebGL2RenderingContext);
    const lighting = {
      direction: [0, 0, 1] as [number, number, number],
      color: "#ffc58c",
      intensity: 2.4,
      ambientColor: "#ffe2c4",
      ambientIntensity: 1.2,
    };
    layer.setLighting(lighting);
    const { sun, ambient } = lightsOf(layer);
    expect(sun.color.getHexString()).toBe("ffc58c");
    expect(sun.intensity).toBe(2.4);
    expect(sun.position.toArray()).toEqual([0, 0, 1]);
    expect(ambient.color.getHexString()).toBe("ffe2c4");
    expect(ambient.intensity).toBe(1.2);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    layer.setLighting({ ...lighting });
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
  });

  it("repaints for a night change only when it changes", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    const map = fakeMap() as { triggerRepaint: ReturnType<typeof vi.fn> };
    layer.onAdd(map as never, {} as WebGL2RenderingContext);
    layer.setNight(true);
    layer.setNight(true);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
  });

  it("setNight switches every placed model", () => {
    const layer = new LandmarkModelLayer({ lighting: NEUTRAL_LIGHTING, onUnsupported: vi.fn() });
    const model = placed("a");
    layer.setPlaced([model]);
    layer.setNight(true);
    expect(model.model.setNight).toHaveBeenCalledWith(true);
  });
});
