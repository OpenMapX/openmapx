import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import {
  createStarCatalog,
  STAR_COUNT,
  STAR_STRIDE,
  skyProjectionMatrix,
  spaceOpacity,
} from "./globeSpace";

const SKY_VERTEX = `#version 300 es
uniform mat3 u_matrix;
out vec3 v_direction;
void main() {
  // A full-screen triangle. Unproject rays, not positions, into the same
  // Earth-fixed frame as the stars. The galaxy and stars rotate together.
  vec2 clip = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  v_direction = inverse(u_matrix) * vec3(clip, 1.0);
  gl_Position = vec4(clip, 1.0, 1.0);
}`;

const SKY_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_opacity;
in vec3 v_direction;
out vec4 fragColor;
void main() {
  vec3 direction = normalize(v_direction);
  // A restrained, procedural galactic band on the celestial sphere. All
  // detail is a function of direction; there are no scrolling clouds or seams.
  float latitude = dot(direction, normalize(vec3(0.3, 0.8, 0.52)));
  float band = exp(-latitude * latitude * 32.0);
  float structure = 0.5 + 0.25 * sin(dot(direction, vec3(19.0, 7.0, -11.0)))
                        + 0.25 * sin(dot(direction, vec3(-31.0, 23.0, 17.0)));
  float dust = smoothstep(0.015, 0.09, abs(latitude + 0.025 * structure));
  vec3 color = vec3(0.008, 0.012, 0.025)
             + vec3(0.034, 0.039, 0.055) * band * (0.4 + 0.6 * structure) * dust;
  fragColor = vec4(color * u_opacity, u_opacity);
}`;

const STAR_VERTEX = `#version 300 es
layout(location = 0) in vec3 a_direction;
layout(location = 1) in vec3 a_appearance;
uniform mat3 u_matrix;
uniform float u_pixel_ratio;
out float v_alpha;
out vec3 v_color;
void main() {
  vec3 projected = u_matrix * a_direction;
  // Put stars at the far plane so Earth's depth buffer occludes them. The
  // camera's translation and far clipping distance cannot move or clip them.
  gl_Position = projected.z > 0.0
    ? vec4(projected.xy, projected.z, projected.z)
    : vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = a_appearance.x * u_pixel_ratio;
  v_alpha = a_appearance.y;
  v_color = mix(vec3(0.72, 0.83, 1.0), vec3(1.0, 0.9, 0.75), a_appearance.z);
}`;

const STAR_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_opacity;
in float v_alpha;
in vec3 v_color;
out vec4 fragColor;
void main() {
  float radius = length(gl_PointCoord * 2.0 - 1.0);
  float alpha = (1.0 - smoothstep(0.0, 1.0, radius)) * v_alpha * u_opacity;
  fragColor = vec4(v_color * alpha, alpha);
}`;

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create globe sky program");
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Unable to create globe sky shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? "Unable to compile globe sky shader");
      }
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "Unable to link globe sky program");
    }
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

function uniforms(gl: WebGL2RenderingContext, program: WebGLProgram) {
  return {
    matrix: gl.getUniformLocation(program, "u_matrix"),
    opacity: gl.getUniformLocation(program, "u_opacity"),
    pixelRatio: gl.getUniformLocation(program, "u_pixel_ratio"),
  };
}

/** A sky at infinity, rendered in the globe's own frame and WebGL context. */
export class GlobeSpaceLayer implements CustomLayerInterface {
  readonly id = "openmapx-globe-space";
  readonly type = "custom";
  readonly renderingMode = "3d";
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private skyProgram: WebGLProgram | null = null;
  private starProgram: WebGLProgram | null = null;
  private skyUniforms: ReturnType<typeof uniforms> | null = null;
  private starUniforms: ReturnType<typeof uniforms> | null = null;
  private skyVao: WebGLVertexArrayObject | null = null;
  private starVao: WebGLVertexArrayObject | null = null;
  private starBuffer: WebGLBuffer | null = null;
  private matrix = new Float32Array(9);

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    // A full setStyle replacement in MapLibre 6 can discard a custom layer
    // without calling onRemove. Release any previous allocation before reuse.
    this.dispose();
    this.map = map;
    this.gl = gl;
    try {
      this.skyProgram = createProgram(gl, SKY_VERTEX, SKY_FRAGMENT);
      this.starProgram = createProgram(gl, STAR_VERTEX, STAR_FRAGMENT);
      this.skyUniforms = uniforms(gl, this.skyProgram);
      this.starUniforms = uniforms(gl, this.starProgram);
      this.skyVao = gl.createVertexArray();
      this.starVao = gl.createVertexArray();
      this.starBuffer = gl.createBuffer();
      if (!this.skyVao || !this.starVao || !this.starBuffer) {
        throw new Error("Unable to allocate globe sky geometry");
      }
      gl.bindVertexArray(this.starVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, createStarCatalog(), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STAR_STRIDE * 4, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STAR_STRIDE * 4, 3 * 4);
    } catch (error) {
      this.dispose();
      // Space is decorative. A shader/allocation failure must leave the map
      // usable with its plain dark background, including on weaker devices.
      console.warn("Unable to render globe space background", error);
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput) {
    if (
      !this.map ||
      !this.skyProgram ||
      !this.starProgram ||
      !this.skyUniforms ||
      !this.starUniforms
    )
      return;
    const opacity = spaceOpacity(
      this.map.getZoom(),
      input.defaultProjectionData.projectionTransition,
    );
    if (opacity === 0) return;

    skyProjectionMatrix(input.modelViewProjectionMatrix, this.matrix);
    // MapLibre gives custom 3D layers a slightly shortened depth range. Use the
    // actual far plane, and never write depth: stars must not occlude map data.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthRange(0, 1);
    gl.depthMask(false);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
    gl.useProgram(this.skyProgram);
    gl.bindVertexArray(this.skyVao);
    gl.uniformMatrix3fv(this.skyUniforms.matrix, false, this.matrix);
    gl.uniform1f(this.skyUniforms.opacity, opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
    gl.useProgram(this.starProgram);
    gl.bindVertexArray(this.starVao);
    gl.uniformMatrix3fv(this.starUniforms.matrix, false, this.matrix);
    gl.uniform1f(this.starUniforms.opacity, opacity);
    gl.uniform1f(this.starUniforms.pixelRatio, this.map.getPixelRatio());
    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);
    gl.bindVertexArray(null);
    // MapLibre resets GL state after custom renders. No second animation loop
    // or move listener: gestures, inertia, flights and resize share this frame.
  }

  onRemove() {
    this.dispose();
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteBuffer(this.starBuffer);
    gl.deleteVertexArray(this.starVao);
    gl.deleteVertexArray(this.skyVao);
    gl.deleteProgram(this.skyProgram);
    gl.deleteProgram(this.starProgram);
    this.starBuffer = this.starVao = this.skyVao = null;
    this.skyProgram = this.starProgram = null;
    this.skyUniforms = this.starUniforms = null;
    this.map = null;
    this.gl = null;
  }
}
