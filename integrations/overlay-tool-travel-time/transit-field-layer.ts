import type { TransitReachabilitySeed } from "@openmapx/core";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { normalizeTransitBands, prepareTransitFieldInstances } from "./transit-field";

const FIELD_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_quad;
layout(location=1) in vec2 a_center;
layout(location=2) in float a_radius_world;
layout(location=3) in float a_remaining_seconds;
layout(location=4) in float a_radius_seconds;
uniform mat4 u_matrix;
out vec2 v_quad;
flat out float v_remaining_seconds;
flat out float v_radius_seconds;
void main() {
  v_quad = a_quad;
  v_remaining_seconds = a_remaining_seconds;
  v_radius_seconds = a_radius_seconds;
  vec2 world = a_center + a_quad * a_radius_world;
  gl_Position = u_matrix * vec4(world, 0.0, 1.0);
}`;

const FIELD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_quad;
flat in float v_remaining_seconds;
flat in float v_radius_seconds;
layout(location=0) out vec4 out_field;
void main() {
  float distance_ratio = length(v_quad);
  if (distance_ratio > 1.0) discard;
  float remaining = max(0.001, v_remaining_seconds - distance_ratio * v_radius_seconds);
  out_field = vec4(remaining, 0.0, 0.0, 1.0);
}`;

const COMPOSITE_VERTEX = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform float u_max_budget;
uniform float u_thresholds[4];
uniform int u_threshold_count;
in vec2 v_uv;
out vec4 out_color;
void main() {
  float remaining = texture(u_field, v_uv).r;
  if (remaining <= 0.0) discard;
  float travel_seconds = u_max_budget - remaining;
  int band = -1;
  for (int i = 0; i < 4; i++) {
    if (i < u_threshold_count && band < 0 && travel_seconds <= u_thresholds[i]) band = i;
  }
  if (band < 0) discard;
  float alphas[4] = float[4](0.38, 0.30, 0.23, 0.17);
  float alpha = alphas[band];
  for (int i = 0; i < 4; i++) {
    if (i < u_threshold_count) {
      float edge = max(fwidth(travel_seconds) * 1.5, 2.0);
      if (abs(travel_seconds - u_thresholds[i]) < edge) alpha = max(alpha, 0.52);
    }
  }
  vec3 purple = vec3(0.435, 0.259, 0.757);
  out_color = vec4(purple * alpha, alpha);
}`;

function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const value = gl.createShader(type);
  if (!value) throw new Error("Unable to allocate transit reachability shader");
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(value) ?? "unknown shader error";
    gl.deleteShader(value);
    throw new Error(`Transit reachability shader failed: ${message}`);
  }
  return value;
}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const value = gl.createProgram();
  if (!value) throw new Error("Unable to allocate transit reachability program");
  let vertexShader: WebGLShader | null = null;
  let fragmentShader: WebGLShader | null = null;
  try {
    vertexShader = shader(gl, gl.VERTEX_SHADER, vertex);
    fragmentShader = shader(gl, gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(value, vertexShader);
    gl.attachShader(value, fragmentShader);
    gl.linkProgram(value);
    if (!gl.getProgramParameter(value, gl.LINK_STATUS)) {
      throw new Error(
        `Transit reachability program failed: ${gl.getProgramInfoLog(value) ?? "unknown link error"}`,
      );
    }
    return value;
  } catch (error) {
    gl.deleteProgram(value);
    throw error;
  } finally {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
  }
}

export type TransitFieldUnsupportedReason = "webgl2" | "float-render-target" | "shader";

export interface TransitFieldLayerOptions {
  id: string;
  seeds: TransitReachabilitySeed[];
  thresholdsMinutes: number[];
  onUnsupported?: (reason: TransitFieldUnsupportedReason) => void;
}

interface SavedGlState {
  framebuffer: WebGLFramebuffer | null;
  viewport: Int32Array;
  depthTest: boolean;
  blend: boolean;
  blendEquationRgb: number;
  blendEquationAlpha: number;
  blendSrcRgb: number;
  blendDstRgb: number;
  blendSrcAlpha: number;
  blendDstAlpha: number;
  program: WebGLProgram | null;
  vertexArray: WebGLVertexArrayObject | null;
  arrayBuffer: WebGLBuffer | null;
  activeTexture: number;
  texture2d: WebGLTexture | null;
  texture0: WebGLTexture | null;
  clearColor: Float32Array;
  scissorTest: boolean;
  colorWriteMask: [boolean, boolean, boolean, boolean];
}

function saveGlState(gl: WebGL2RenderingContext): SavedGlState {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  const texture2d = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  let texture0 = texture2d;
  if (activeTexture !== gl.TEXTURE0) {
    gl.activeTexture(gl.TEXTURE0);
    texture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.activeTexture(activeTexture);
  }
  const colorWriteMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
  return {
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    viewport: new Int32Array(gl.getParameter(gl.VIEWPORT) as Int32Array),
    depthTest: gl.isEnabled(gl.DEPTH_TEST),
    blend: gl.isEnabled(gl.BLEND),
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB) as number,
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number,
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
    activeTexture,
    texture2d,
    texture0,
    clearColor: new Float32Array(gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array),
    scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
    colorWriteMask: [
      colorWriteMask[0] ?? true,
      colorWriteMask[1] ?? true,
      colorWriteMask[2] ?? true,
      colorWriteMask[3] ?? true,
    ],
  };
}

function restoreGlState(gl: WebGL2RenderingContext, state: SavedGlState): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
  gl.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
  state.depthTest ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
  state.blend ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND);
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  gl.blendFuncSeparate(
    state.blendSrcRgb,
    state.blendDstRgb,
    state.blendSrcAlpha,
    state.blendDstAlpha,
  );
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture0);
  gl.activeTexture(state.activeTexture);
  if (state.activeTexture !== gl.TEXTURE0) gl.bindTexture(gl.TEXTURE_2D, state.texture2d);
  gl.clearColor(state.clearColor[0], state.clearColor[1], state.clearColor[2], state.clearColor[3]);
  state.scissorTest ? gl.enable(gl.SCISSOR_TEST) : gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(...state.colorWriteMask);
}

export class TransitFieldLayer implements CustomLayerInterface {
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  readonly id: string;

  private map: MapLibreMap | null = null;
  private fieldProgram: WebGLProgram | null = null;
  private compositeProgram: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private fieldVao: WebGLVertexArrayObject | null = null;
  private compositeVao: WebGLVertexArrayObject | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  private width = 0;
  private height = 0;
  private instanceCount = 0;
  private seeds: TransitReachabilitySeed[];
  private thresholdsMinutes: number[];
  private instancesDirty = true;
  private uploadedBudgetSeconds = -1;
  private unsupported = false;
  private readonly onUnsupported?: (reason: TransitFieldUnsupportedReason) => void;

  constructor(options: TransitFieldLayerOptions) {
    this.id = options.id;
    this.seeds = options.seeds;
    this.thresholdsMinutes = normalizeTransitBands(options.thresholdsMinutes);
    this.onUnsupported = options.onUnsupported;
  }

  private releaseResources(gl: WebGL2RenderingContext): void {
    if (this.fieldProgram) gl.deleteProgram(this.fieldProgram);
    if (this.compositeProgram) gl.deleteProgram(this.compositeProgram);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
    if (this.fieldVao) gl.deleteVertexArray(this.fieldVao);
    if (this.compositeVao) gl.deleteVertexArray(this.compositeVao);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.texture) gl.deleteTexture(this.texture);
    this.fieldProgram = null;
    this.compositeProgram = null;
    this.quadBuffer = null;
    this.instanceBuffer = null;
    this.fieldVao = null;
    this.compositeVao = null;
    this.framebuffer = null;
    this.texture = null;
  }

  setData(seeds: TransitReachabilitySeed[], thresholdsMinutes: number[]): void {
    this.seeds = seeds;
    this.thresholdsMinutes = normalizeTransitBands(thresholdsMinutes);
    this.instancesDirty = true;
    if (this.map) this.map.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) {
      this.unsupported = true;
      this.onUnsupported?.("webgl2");
      return;
    }
    const previous = saveGlState(gl);
    try {
      if (!gl.getExtension("EXT_color_buffer_float") || !gl.getExtension("EXT_float_blend")) {
        this.unsupported = true;
        this.onUnsupported?.("float-render-target");
        return;
      }
      try {
        this.fieldProgram = program(gl, FIELD_VERTEX, FIELD_FRAGMENT);
        this.compositeProgram = program(gl, COMPOSITE_VERTEX, COMPOSITE_FRAGMENT);
      } catch {
        this.unsupported = true;
        this.onUnsupported?.("shader");
        this.releaseResources(gl);
        return;
      }
      this.quadBuffer = gl.createBuffer();
      this.instanceBuffer = gl.createBuffer();
      this.fieldVao = gl.createVertexArray();
      this.compositeVao = gl.createVertexArray();
      this.framebuffer = gl.createFramebuffer();
      this.texture = gl.createTexture();
      if (
        !this.quadBuffer ||
        !this.instanceBuffer ||
        !this.fieldVao ||
        !this.compositeVao ||
        !this.framebuffer ||
        !this.texture
      ) {
        this.unsupported = true;
        this.onUnsupported?.("webgl2");
        this.releaseResources(gl);
        return;
      }
      gl.bindVertexArray(this.fieldVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(1, 1);
      for (let location = 2; location <= 4; location += 1) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(
          location,
          1,
          gl.FLOAT,
          false,
          stride,
          (location + 0) * Float32Array.BYTES_PER_ELEMENT,
        );
        gl.vertexAttribDivisor(location, 1);
      }
    } catch {
      this.unsupported = true;
      this.onUnsupported?.("webgl2");
      this.releaseResources(gl);
    } finally {
      restoreGlState(gl, previous);
    }
  }

  private uploadInstances(gl: WebGL2RenderingContext, maxBudgetSeconds: number): void {
    const instances = prepareTransitFieldInstances(this.seeds, maxBudgetSeconds);
    const values = new Float32Array(instances.length * 5);
    instances.forEach((instance, index) => {
      values.set(
        [
          instance.x,
          instance.y,
          instance.radiusWorld,
          instance.remainingSeconds,
          instance.radiusSeconds,
        ],
        index * 5,
      );
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW);
    this.instanceCount = instances.length;
    this.instancesDirty = false;
    this.uploadedBudgetSeconds = maxBudgetSeconds;
  }

  private resize(gl: WebGL2RenderingContext): boolean {
    if (this.width === gl.drawingBufferWidth && this.height === gl.drawingBufferHeight) return true;
    this.width = gl.drawingBufferWidth;
    this.height = gl.drawingBufferHeight;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.width, this.height, 0, gl.RED, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.unsupported = true;
      this.onUnsupported?.("float-render-target");
      this.releaseResources(gl);
      return false;
    }
    return true;
  }

  prerender(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (this.unsupported || !this.fieldProgram || this.thresholdsMinutes.length === 0) return;
    const maxMinutes = this.thresholdsMinutes.at(-1);
    if (maxMinutes === undefined) return;
    const maxBudgetSeconds = maxMinutes * 60;
    const previous = saveGlState(gl);
    try {
      if (!this.resize(gl)) return;
      if (this.instancesDirty || this.uploadedBudgetSeconds !== maxBudgetSeconds) {
        this.uploadInstances(gl, maxBudgetSeconds);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.fieldProgram);
      gl.uniformMatrix4fv(
        gl.getUniformLocation(this.fieldProgram, "u_matrix"),
        false,
        args.modelViewProjectionMatrix,
      );
      gl.bindVertexArray(this.fieldVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
    } finally {
      restoreGlState(gl, previous);
    }
  }

  render(gl: WebGL2RenderingContext): void {
    if (this.unsupported || !this.compositeProgram || this.thresholdsMinutes.length === 0) return;
    const maxMinutes = this.thresholdsMinutes.at(-1);
    if (maxMinutes === undefined) return;
    const thresholds = this.thresholdsMinutes.map((minutes) => minutes * 60);
    while (thresholds.length < 4) thresholds.push(0);
    const previous = saveGlState(gl);
    try {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.compositeProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(gl.getUniformLocation(this.compositeProgram, "u_field"), 0);
      gl.uniform1f(gl.getUniformLocation(this.compositeProgram, "u_max_budget"), maxMinutes * 60);
      gl.uniform1fv(
        gl.getUniformLocation(this.compositeProgram, "u_thresholds"),
        new Float32Array(thresholds),
      );
      gl.uniform1i(
        gl.getUniformLocation(this.compositeProgram, "u_threshold_count"),
        this.thresholdsMinutes.length,
      );
      gl.bindVertexArray(this.compositeVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      restoreGlState(gl, previous);
    }
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.releaseResources(gl);
    this.map = null;
  }
}
