import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobeSpaceLayer } from "./GlobeSpaceLayer";

function createContext() {
  const resources = { programs: [] as object[], shaders: [] as object[], buffers: [] as object[] };
  const allocate = (pool: object[]) => {
    const resource = {};
    pool.push(resource);
    return resource;
  };
  return {
    resources,
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
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
    getUniformLocation: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    deleteShader: vi.fn(),
    deleteProgram: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteBuffer: vi.fn(),
    drawArrays: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("GlobeSpaceLayer GPU lifecycle", () => {
  it("releases old resources even when a replacement style skipped onRemove", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    const map = {} as MapLibreMap;
    const layer = new GlobeSpaceLayer();
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
    layer.render(gl, {} as CustomRenderMethodInput);
    expect(context.drawArrays).not.toHaveBeenCalled();
  });

  it("cleans up a failed shader and leaves a safe no-op layer", () => {
    const context = createContext();
    const gl = context as unknown as WebGL2RenderingContext;
    context.getShaderParameter.mockReturnValue(false);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const layer = new GlobeSpaceLayer();
    expect(() => layer.onAdd({} as MapLibreMap, gl)).not.toThrow();
    expect(context.deleteShader).toHaveBeenCalledWith(context.resources.shaders[0]);
    expect(context.deleteProgram).toHaveBeenCalledWith(context.resources.programs[0]);
    expect(warning).toHaveBeenCalledTimes(1);
    layer.render(gl, {} as CustomRenderMethodInput);
    expect(context.drawArrays).not.toHaveBeenCalled();
  });
});
