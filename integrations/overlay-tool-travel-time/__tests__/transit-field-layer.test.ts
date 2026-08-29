import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransitFieldLayer } from "../transit-field-layer";

class FakeWebGL2RenderingContext {
  readonly VERTEX_SHADER = 1;
  readonly FRAGMENT_SHADER = 2;
  readonly COMPILE_STATUS = 3;
  readonly LINK_STATUS = 4;
  readonly ARRAY_BUFFER = 5;
  readonly STATIC_DRAW = 6;
  readonly DYNAMIC_DRAW = 7;
  readonly FLOAT = 8;
  readonly FRAMEBUFFER = 9;
  readonly TEXTURE_2D = 10;
  readonly TEXTURE_MIN_FILTER = 11;
  readonly TEXTURE_MAG_FILTER = 12;
  readonly TEXTURE_WRAP_S = 13;
  readonly TEXTURE_WRAP_T = 14;
  readonly NEAREST = 15;
  readonly CLAMP_TO_EDGE = 16;
  readonly R32F = 17;
  readonly RED = 18;
  readonly COLOR_ATTACHMENT0 = 19;
  readonly FRAMEBUFFER_COMPLETE = 20;
  readonly FRAMEBUFFER_BINDING = 21;
  readonly VIEWPORT = 22;
  readonly DEPTH_TEST = 23;
  readonly BLEND = 24;
  readonly BLEND_EQUATION_RGB = 25;
  readonly BLEND_EQUATION_ALPHA = 26;
  readonly BLEND_SRC_RGB = 27;
  readonly BLEND_DST_RGB = 28;
  readonly BLEND_SRC_ALPHA = 29;
  readonly BLEND_DST_ALPHA = 30;
  readonly CURRENT_PROGRAM = 31;
  readonly VERTEX_ARRAY_BINDING = 32;
  readonly ARRAY_BUFFER_BINDING = 33;
  readonly ACTIVE_TEXTURE = 34;
  readonly TEXTURE_BINDING_2D = 35;
  readonly COLOR_CLEAR_VALUE = 36;
  readonly COLOR_BUFFER_BIT = 37;
  readonly MAX = 38;
  readonly ONE = 39;
  readonly FUNC_ADD = 40;
  readonly ONE_MINUS_SRC_ALPHA = 41;
  readonly TEXTURE0 = 42;
  readonly TRIANGLES = 43;
  readonly SCISSOR_TEST = 44;
  readonly COLOR_WRITEMASK = 45;

  drawingBufferWidth = 320;
  drawingBufferHeight = 200;
  bufferDataCalls = 0;
  deleted = { programs: 0, buffers: 0, vaos: 0, framebuffers: 0, textures: 0 };
  private sequence = 0;
  private enabled = new Set<number>([this.DEPTH_TEST, this.SCISSOR_TEST]);
  private state = new Map<number, unknown>([
    [this.FRAMEBUFFER_BINDING, { prior: "framebuffer" }],
    [this.VIEWPORT, new Int32Array([7, 8, 90, 100])],
    [this.BLEND_EQUATION_RGB, this.FUNC_ADD],
    [this.BLEND_EQUATION_ALPHA, this.FUNC_ADD],
    [this.BLEND_SRC_RGB, 101],
    [this.BLEND_DST_RGB, 102],
    [this.BLEND_SRC_ALPHA, 103],
    [this.BLEND_DST_ALPHA, 104],
    [this.CURRENT_PROGRAM, { prior: "program" }],
    [this.VERTEX_ARRAY_BINDING, { prior: "vao" }],
    [this.ARRAY_BUFFER_BINDING, { prior: "buffer" }],
    [this.ACTIVE_TEXTURE, 77],
    [this.TEXTURE_BINDING_2D, { prior: "texture" }],
    [this.COLOR_CLEAR_VALUE, new Float32Array([0.1, 0.2, 0.3, 0.4])],
    [this.COLOR_WRITEMASK, [false, true, false, true]],
  ]);

  snapshot() {
    return {
      framebuffer: this.state.get(this.FRAMEBUFFER_BINDING),
      viewport: Array.from(this.state.get(this.VIEWPORT) as Int32Array),
      depth: this.isEnabled(this.DEPTH_TEST),
      blend: this.isEnabled(this.BLEND),
      equations: [
        this.state.get(this.BLEND_EQUATION_RGB),
        this.state.get(this.BLEND_EQUATION_ALPHA),
      ],
      funcs: [
        this.state.get(this.BLEND_SRC_RGB),
        this.state.get(this.BLEND_DST_RGB),
        this.state.get(this.BLEND_SRC_ALPHA),
        this.state.get(this.BLEND_DST_ALPHA),
      ],
      program: this.state.get(this.CURRENT_PROGRAM),
      vao: this.state.get(this.VERTEX_ARRAY_BINDING),
      buffer: this.state.get(this.ARRAY_BUFFER_BINDING),
      activeTexture: this.state.get(this.ACTIVE_TEXTURE),
      texture: this.state.get(this.TEXTURE_BINDING_2D),
      clearColor: Array.from(this.state.get(this.COLOR_CLEAR_VALUE) as Float32Array),
      scissor: this.isEnabled(this.SCISSOR_TEST),
      colorMask: this.state.get(this.COLOR_WRITEMASK),
    };
  }

  private object(kind: string) {
    return { kind, id: ++this.sequence };
  }
  getExtension() {
    return {};
  }
  createShader() {
    return this.object("shader");
  }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() {
    return true;
  }
  getShaderInfoLog() {
    return "";
  }
  deleteShader() {}
  createProgram() {
    return this.object("program");
  }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() {
    return true;
  }
  getProgramInfoLog() {
    return "";
  }
  createBuffer() {
    return this.object("buffer");
  }
  createVertexArray() {
    return this.object("vao");
  }
  createFramebuffer() {
    return this.object("framebuffer");
  }
  createTexture() {
    return this.object("texture");
  }
  bindVertexArray(value: unknown) {
    this.state.set(this.VERTEX_ARRAY_BINDING, value);
  }
  bindBuffer(_target: number, value: unknown) {
    this.state.set(this.ARRAY_BUFFER_BINDING, value);
  }
  bufferData() {
    this.bufferDataCalls += 1;
  }
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  vertexAttribDivisor() {}
  bindTexture(_target: number, value: unknown) {
    this.state.set(this.TEXTURE_BINDING_2D, value);
  }
  texParameteri() {}
  texImage2D() {}
  bindFramebuffer(_target: number, value: unknown) {
    this.state.set(this.FRAMEBUFFER_BINDING, value);
  }
  framebufferTexture2D() {}
  checkFramebufferStatus() {
    return this.FRAMEBUFFER_COMPLETE;
  }
  getParameter(parameter: number) {
    return this.state.get(parameter);
  }
  isEnabled(capability: number) {
    return this.enabled.has(capability);
  }
  enable(capability: number) {
    this.enabled.add(capability);
  }
  disable(capability: number) {
    this.enabled.delete(capability);
  }
  viewport(x: number, y: number, width: number, height: number) {
    this.state.set(this.VIEWPORT, new Int32Array([x, y, width, height]));
  }
  blendEquation(value: number) {
    this.state.set(this.BLEND_EQUATION_RGB, value);
    this.state.set(this.BLEND_EQUATION_ALPHA, value);
  }
  blendEquationSeparate(rgb: number, alpha: number) {
    this.state.set(this.BLEND_EQUATION_RGB, rgb);
    this.state.set(this.BLEND_EQUATION_ALPHA, alpha);
  }
  blendFunc(source: number, destination: number) {
    this.blendFuncSeparate(source, destination, source, destination);
  }
  blendFuncSeparate(
    sourceRgb: number,
    destinationRgb: number,
    sourceAlpha: number,
    destinationAlpha: number,
  ) {
    this.state.set(this.BLEND_SRC_RGB, sourceRgb);
    this.state.set(this.BLEND_DST_RGB, destinationRgb);
    this.state.set(this.BLEND_SRC_ALPHA, sourceAlpha);
    this.state.set(this.BLEND_DST_ALPHA, destinationAlpha);
  }
  clearColor(red: number, green: number, blue: number, alpha: number) {
    this.state.set(this.COLOR_CLEAR_VALUE, new Float32Array([red, green, blue, alpha]));
  }
  clear() {}
  colorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean) {
    this.state.set(this.COLOR_WRITEMASK, [red, green, blue, alpha]);
  }
  useProgram(value: unknown) {
    this.state.set(this.CURRENT_PROGRAM, value);
  }
  getUniformLocation() {
    return {};
  }
  uniformMatrix4fv() {}
  uniform1i() {}
  uniform1f() {}
  uniform1fv() {}
  drawArraysInstanced() {}
  activeTexture(value: number) {
    this.state.set(this.ACTIVE_TEXTURE, value);
  }
  drawArrays() {}
  deleteProgram() {
    this.deleted.programs += 1;
  }
  deleteBuffer() {
    this.deleted.buffers += 1;
  }
  deleteVertexArray() {
    this.deleted.vaos += 1;
  }
  deleteFramebuffer() {
    this.deleted.framebuffers += 1;
  }
  deleteTexture() {
    this.deleted.textures += 1;
  }
}

describe("TransitFieldLayer WebGL lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("WebGL2RenderingContext", FakeWebGL2RenderingContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uploads only changed instances, restores state, and releases owned resources", () => {
    const gl = new FakeWebGL2RenderingContext();
    const initialState = gl.snapshot();
    const map = { triggerRepaint: vi.fn() };
    const layer = new TransitFieldLayer({
      id: "field",
      seeds: [{ lng: 13.4, lat: 52.5, arrivalSeconds: 0 }],
      thresholdsMinutes: [15, 30],
    });
    layer.onAdd(map as never, gl as never);
    const afterStaticUpload = gl.bufferDataCalls;
    const args = { modelViewProjectionMatrix: new Float32Array(16) } as never;

    layer.prerender(gl as never, args);
    expect(gl.bufferDataCalls).toBe(afterStaticUpload + 1);
    expect(gl.snapshot()).toEqual(initialState);
    layer.prerender(gl as never, args);
    expect(gl.bufferDataCalls).toBe(afterStaticUpload + 1);

    layer.setData([{ lng: 13.5, lat: 52.6, arrivalSeconds: 60 }], [30]);
    expect(map.triggerRepaint).toHaveBeenCalledOnce();
    layer.prerender(gl as never, args);
    expect(gl.bufferDataCalls).toBe(afterStaticUpload + 2);
    layer.render(gl as never);
    expect(gl.snapshot()).toEqual(initialState);

    layer.onRemove(map as never, gl as never);
    expect(gl.deleted).toEqual({
      programs: 2,
      buffers: 2,
      vaos: 2,
      framebuffers: 1,
      textures: 1,
    });
  });
});
