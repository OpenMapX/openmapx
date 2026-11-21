import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobeSkyLayer, type GlobeSkyOptions } from "./GlobeSkyLayer";
import { MILKY_WAY_URL, NIGHT_LIGHTS_URL } from "./globeTextures";
import { STAR_COUNT } from "./starCatalog";

function createContext() {
  const resources = { programs: [] as object[], shaders: [] as object[], buffers: [] as object[] };
  const allocate = (pool: object[]) => {
    const resource = {};
    pool.push(resource);
    return resource;
  };
  const uniforms = new Map<string, unknown[]>();
  const setUniform =
    () =>
    (location: { name: string }, ...values: unknown[]) =>
      uniforms.set(location.name, values);
  return {
    resources,
    uniforms,
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    TRIANGLES: 4,
    POINTS: 0,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    DEPTH_TEST: 0x0b71,
    MAX_TEXTURE_SIZE: 0x0d33,
    maxTextureSize: 16384,
    createProgram: vi.fn(() => allocate(resources.programs)),
    createShader: vi.fn(() => allocate(resources.shaders)),
    createVertexArray: vi.fn(() => ({})),
    createBuffer: vi.fn(() => allocate(resources.buffers)),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => "test shader failure"),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => "test link failure"),
    getParameter: vi.fn(function (this: { maxTextureSize: number }) {
      return this.maxTextureSize;
    }),
    getUniformLocation: vi.fn((_program: object, name: string) => ({ name })),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    deleteShader: vi.fn(),
    deleteProgram: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteTexture: vi.fn(),
    drawArrays: vi.fn(),
    useProgram: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    depthMask: vi.fn(),
    blendFunc: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    createTexture: vi.fn(() => ({})),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    generateMipmap: vi.fn(),
    uniform1f: vi.fn(setUniform()),
    uniform1i: vi.fn(setUniform()),
    uniform3f: vi.fn(setUniform()),
    uniform3fv: vi.fn(setUniform()),
    uniformMatrix3fv: vi.fn(setUniform()),
    uniformMatrix4fv: vi.fn(setUniform()),
  };
}

const OPTIONS: GlobeSkyOptions = {
  lighting: true,
  base: "satellite",
  dark: false,
  themeSky: [0.008, 0.012, 0.024],
};

// Any invertible perspective camera works for the layer's control flow.
const MATRIX = [2, 0, 0, 0, 0, 3, 0, 0, -0.2, 0.1, -1.01, -1, 40, -25, -500, 501];

function createMap(zoom: number) {
  return {
    getZoom: vi.fn(() => zoom),
    getPixelRatio: vi.fn(() => 2),
    triggerRepaint: vi.fn(),
  };
}

function input(transition = 1) {
  return {
    modelViewProjectionMatrix: MATRIX,
    defaultProjectionData: { projectionTransition: transition },
  } as unknown as CustomRenderMethodInput;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GlobeSkyLayer GPU lifecycle", () => {
  it("releases old resources even when a replacement style skipped onRemove", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const map = createMap(3) as unknown as MapLibreMap;
    const layer = new GlobeSkyLayer(OPTIONS);
    layer.onAdd(map, gl);
    const oldBuffer = context.resources.buffers[0];
    const oldPrograms = [...context.resources.programs];
    layer.onAdd(map, gl);
    expect(context.deleteBuffer).toHaveBeenCalledWith(oldBuffer);
    for (const program of oldPrograms) expect(context.deleteProgram).toHaveBeenCalledWith(program);
    expect(context.deleteVertexArray).toHaveBeenCalledTimes(2);

    layer.dispose(); // React cleanup after the layer was dropped from the style.
    layer.onRemove(); // A late or repeated callback must also be safe.
    expect(context.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(context.deleteVertexArray).toHaveBeenCalledTimes(4);
    expect(context.deleteProgram).toHaveBeenCalledTimes(4);
    layer.render(gl, input());
    expect(context.drawArrays).not.toHaveBeenCalled();
  });

  it("cleans up a failed shader and leaves a safe no-op layer", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    context.getShaderParameter.mockReturnValue(false);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const layer = new GlobeSkyLayer(OPTIONS);
    expect(() => layer.onAdd(createMap(3) as unknown as MapLibreMap, gl)).not.toThrow();
    expect(context.deleteShader).toHaveBeenCalledWith(context.resources.shaders[0]);
    expect(context.deleteProgram).toHaveBeenCalledWith(context.resources.programs[0]);
    expect(warning).toHaveBeenCalledTimes(1);
    layer.render(gl, input());
    expect(context.drawArrays).not.toHaveBeenCalled();
  });
});

describe("GlobeSkyLayer rendering", () => {
  it("draws the sky and the stars at globe zoom", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const layer = new GlobeSkyLayer(OPTIONS);
    layer.onAdd(createMap(3) as unknown as MapLibreMap, gl);
    layer.render(gl, input());
    expect(context.drawArrays.mock.calls).toEqual([
      [context.TRIANGLES, 0, 3],
      [context.POINTS, 0, STAR_COUNT],
    ]);
    expect(context.uniforms.get("u_space")).toEqual([1]);
    expect(context.uniforms.get("u_surface")).toEqual([1]);
    expect(context.uniforms.get("u_lighting")).toEqual([1]);
    expect(context.uniforms.get("u_night")).toEqual([0.1]);
    expect(context.uniforms.get("u_theme_sky")).toEqual([0.008, 0.012, 0.024]);
    expect(context.uniforms.get("u_day_falloff")).toEqual([1]);
  });

  it("keeps MapLibre's depth test so opaque fills above stay on top, and never writes depth", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const layer = new GlobeSkyLayer(OPTIONS);
    layer.onAdd(createMap(3) as unknown as MapLibreMap, gl);
    layer.render(gl, input());
    expect(context.disable).not.toHaveBeenCalledWith(context.DEPTH_TEST);
    expect(context.depthMask).toHaveBeenCalledWith(false);
  });

  it("leaves out city lights on GPUs without 4096-pixel textures", () => {
    const context = createContext();
    context.maxTextureSize = 2048;
    const gl = context as unknown as WebGL2RenderingContext;
    const layer = new GlobeSkyLayer(OPTIONS);
    layer.onAdd(createMap(3) as unknown as MapLibreMap, gl);
    layer.render(gl, input());
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => url);
    expect(urls).toEqual([MILKY_WAY_URL]);
    layer.dispose();
  });

  it("draws nothing from zoom 8 or over the flat projection", () => {
    for (const [zoom, transition] of [
      [8, 1],
      [3, 0],
    ]) {
      const context = createContext();
      const gl = context as unknown as WebGL2RenderingContext;
      const layer = new GlobeSkyLayer(OPTIONS);
      layer.onAdd(createMap(zoom) as unknown as MapLibreMap, gl);
      layer.render(gl, input(transition));
      expect(context.drawArrays).not.toHaveBeenCalled();
    }
  });

  it("keeps the sky but drops the stars once only the lighting fade remains", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const layer = new GlobeSkyLayer(OPTIONS);
    layer.onAdd(createMap(6.5) as unknown as MapLibreMap, gl);
    layer.render(gl, input());
    expect(context.uniforms.get("u_space")).toEqual([0.5]);
    expect(context.drawArrays).toHaveBeenCalledWith(context.POINTS, 0, STAR_COUNT);
  });

  it("requests city lights only for satellite imagery with lighting on", () => {
    const cases: Array<[Partial<GlobeSkyOptions>, boolean]> = [
      [{}, true],
      [{ lighting: false }, false],
      [{ base: "map" }, false],
    ];
    for (const [overrides, expected] of cases) {
      vi.mocked(fetch).mockClear();
      const context = createContext();
      const gl = context as unknown as WebGL2RenderingContext;
      const layer = new GlobeSkyLayer({ ...OPTIONS, ...overrides });
      layer.onAdd(createMap(3) as unknown as MapLibreMap, gl);
      layer.render(gl, input());
      const urls = vi.mocked(fetch).mock.calls.map(([url]) => url);
      expect(urls).toContain(MILKY_WAY_URL);
      expect(urls.includes(NIGHT_LIGHTS_URL)).toBe(expected);
      expect(context.uniforms.get("u_lights")).toEqual([0]);
      layer.dispose();
    }
  });

  it("lights the globe evenly with lighting off and keeps vector maps legible at night", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const layer = new GlobeSkyLayer({ ...OPTIONS, lighting: false, base: "map", dark: true });
    layer.onAdd(createMap(3) as unknown as MapLibreMap, gl);
    layer.render(gl, input());
    expect(context.uniforms.get("u_lighting")).toEqual([0]);
    expect(context.uniforms.get("u_night")).toEqual([0.55]);
    expect(context.uniforms.get("u_day_falloff")).toEqual([0]);
    layer.setOptions({ ...OPTIONS, lighting: true, base: "map", dark: false });
    layer.render(gl, input());
    expect(context.uniforms.get("u_lighting")).toEqual([1]);
    expect(context.uniforms.get("u_night")).toEqual([0.45]);
  });

  it("repaints after an option change", () => {
    const map = createMap(3);
    const layer = new GlobeSkyLayer(OPTIONS);
    layer.onAdd(
      map as unknown as MapLibreMap,
      createContext() as unknown as WebGL2RenderingContext,
    );
    layer.setOptions({ ...OPTIONS, lighting: false });
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
  });
});

describe("GlobeSkyLayer textures and credits", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps its textures across a style reload in the same GL context", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const map = createMap(3) as unknown as MapLibreMap;
    const layer = new GlobeSkyLayer(OPTIONS);
    layer.onAdd(map, gl);
    layer.render(gl, input());
    expect(fetch).toHaveBeenCalledTimes(2);

    layer.onRemove();
    layer.onAdd(map, gl);
    layer.render(gl, input());
    expect(fetch).toHaveBeenCalledTimes(2);

    // A restored context has none of the old GPU objects.
    const restored = createContext() as unknown as WebGL2RenderingContext;
    layer.onAdd(map, restored);
    layer.render(restored, input());
    expect(fetch).toHaveBeenCalledTimes(4);
    layer.dispose();
  });

  it("reports the imagery it draws, and nothing once it stops drawing", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(new Blob(["image"])));
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ close: vi.fn() })),
    );
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const onContent = vi.fn();
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const map = createMap(3);
    const layer = new GlobeSkyLayer(OPTIONS, { onContent });
    layer.onAdd(map as unknown as MapLibreMap, gl);
    layer.render(gl, input());
    await flush();
    layer.render(gl, input());
    expect(onContent).not.toHaveBeenCalled();

    now.mockReturnValue(2000);
    layer.render(gl, input());
    expect(onContent).toHaveBeenLastCalledWith({ milkyWay: true, nightLights: true });

    layer.setOptions({ ...OPTIONS, lighting: false });
    layer.render(gl, input());
    expect(onContent).toHaveBeenLastCalledWith({ milkyWay: true, nightLights: false });

    map.getZoom.mockReturnValue(8);
    layer.render(gl, input());
    expect(onContent).toHaveBeenLastCalledWith({ milkyWay: false, nightLights: false });
    expect(onContent).toHaveBeenCalledTimes(3);
  });

  it("tells the caller when the GPU cannot run it", () => {
    const context = createContext();
    context.getProgramParameter.mockReturnValue(false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onUnavailable = vi.fn();
    const layer = new GlobeSkyLayer(OPTIONS, { onUnavailable });
    layer.onAdd(
      createMap(3) as unknown as MapLibreMap,
      context as unknown as WebGL2RenderingContext,
    );
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
