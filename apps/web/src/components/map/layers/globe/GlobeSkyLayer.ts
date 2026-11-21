import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { galacticRotation } from "./celestialFrame";
import {
  cameraPosition,
  invertMatrix,
  skyProjectionMatrix,
  spaceAmount,
  surfaceFade,
} from "./globeCamera";
import { SKY_FRAGMENT, SKY_VERTEX, STAR_FRAGMENT, STAR_VERTEX } from "./globeShaders";
import { GlobeTexture, MILKY_WAY_URL, NIGHT_LIGHTS_URL } from "./globeTextures";
import { createStarCatalog, STAR_COUNT, STAR_STRIDE } from "./starCatalog";
import { sunDirection } from "./sunPosition";

export const GLOBE_SKY_LAYER_ID = "openmapx-globe-sky";

export interface GlobeSkyOptions {
  /** Real-time day and night; off lights the whole globe evenly. */
  lighting: boolean;
  /**
   * Satellite imagery gets a darker night, daylight falloff and city lights;
   * every other base map (vector or raster) stays legible.
   */
  base: "satellite" | "map";
  dark: boolean;
  /** The colour behind the globe when it is not space, as sRGB 0–1. */
  themeSky: readonly [number, number, number];
}

const NIGHT_BRIGHTNESS = { satellite: 0.1, mapLight: 0.45, mapDark: 0.55 } as const;
/** The night-lights texture's width; WebGL2 only guarantees 2048. */
const NIGHT_LIGHTS_SIZE = 4096;
const NIGHT_LIGHTS_UNIT = 0;
const MILKY_WAY_UNIT = 1;

const SKY_UNIFORMS = [
  "u_inverse",
  "u_sun",
  "u_galactic",
  "u_lighting",
  "u_space",
  "u_surface",
  "u_theme_sky",
  "u_night",
  "u_day_falloff",
  "u_lights",
  "u_galaxy",
  "u_night_lights",
  "u_milky_way",
] as const;
const STAR_UNIFORMS = ["u_matrix", "u_to_globe", "u_camera", "u_pixel_ratio", "u_opacity"] as const;

type Uniforms<Names extends readonly string[]> = Record<Names[number], WebGLUniformLocation | null>;

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

function locate<Names extends readonly string[]>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: Names,
): Uniforms<Names> {
  return Object.fromEntries(
    names.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Uniforms<Names>;
}

/**
 * Space, the atmosphere's glow, day and night and city lights for the
 * zoomed-out globe, in one full-screen pass plus a point draw for the stars.
 *
 * Each pixel's ray is intersected with the unit sphere. Outside it the layer
 * paints the sky opaquely; on it, a translucent layer over the map that is
 * already drawn. It sits below every overlay and label, so those stay legible
 * on the night side. Rendering follows MapLibre's own frames: no animation
 * loop, and nothing at all from zoom 8, where the map looks as it always did.
 */
export class GlobeSkyLayer implements CustomLayerInterface {
  readonly id = GLOBE_SKY_LAYER_ID;
  readonly type = "custom";
  readonly renderingMode = "2d";
  private options: GlobeSkyOptions;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private skyProgram: WebGLProgram | null = null;
  private starProgram: WebGLProgram | null = null;
  private skyUniforms: Uniforms<typeof SKY_UNIFORMS> | null = null;
  private starUniforms: Uniforms<typeof STAR_UNIFORMS> | null = null;
  private skyVao: WebGLVertexArrayObject | null = null;
  private starVao: WebGLVertexArrayObject | null = null;
  private starBuffer: WebGLBuffer | null = null;
  private nightLightsSupported = false;
  private readonly nightLights = new GlobeTexture(NIGHT_LIGHTS_URL, "r8");
  private readonly milkyWay = new GlobeTexture(MILKY_WAY_URL, "rgb8");
  private readonly inverse64 = new Float64Array(16);
  private readonly inverse = new Float32Array(16);
  private readonly sun = new Float32Array(3);
  private readonly galactic = new Float32Array(9);
  private readonly camera = new Float32Array(3);
  private readonly skyMatrix = new Float32Array(9);

  constructor(options: GlobeSkyOptions) {
    this.options = options;
  }

  setOptions(options: GlobeSkyOptions): void {
    this.options = options;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    // A full setStyle replacement in MapLibre 6 can discard a custom layer
    // without calling onRemove. Release any previous allocation before reuse.
    this.dispose();
    this.map = map;
    this.gl = gl;
    try {
      this.skyProgram = createProgram(gl, SKY_VERTEX, SKY_FRAGMENT);
      this.starProgram = createProgram(gl, STAR_VERTEX, STAR_FRAGMENT);
      this.skyUniforms = locate(gl, this.skyProgram, SKY_UNIFORMS);
      this.starUniforms = locate(gl, this.starProgram, STAR_UNIFORMS);
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
      this.nightLightsSupported = gl.getParameter(gl.MAX_TEXTURE_SIZE) >= NIGHT_LIGHTS_SIZE;
    } catch (error) {
      this.disposeGl();
      // The sky is decorative. A shader/allocation failure must leave the map
      // usable with its plain background, including on weaker devices.
      console.warn("Unable to render the globe sky", error);
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    const map = this.map;
    const sky = this.skyUniforms;
    const stars = this.starUniforms;
    if (!map || !this.skyProgram || !this.starProgram || !sky || !stars) return;
    const transition = input.defaultProjectionData.projectionTransition;
    const zoom = map.getZoom();
    const space = spaceAmount(zoom, transition);
    const surface = surfaceFade(zoom, transition);
    if (space === 0 && surface === 0) return;
    const inverse = invertMatrix(input.modelViewProjectionMatrix, this.inverse64);
    if (!inverse) return;
    this.inverse.set(inverse);
    cameraPosition(inverse, this.camera);
    skyProjectionMatrix(input.modelViewProjectionMatrix, this.skyMatrix);
    const now = new Date();
    sunDirection(now, this.sun);
    galacticRotation(now, this.galactic);

    const { lighting, base, dark, themeSky } = this.options;
    const wantsLights = lighting && base === "satellite" && this.nightLightsSupported;
    const repaint = () => map.triggerRepaint();
    this.milkyWay.load(repaint);
    if (wantsLights) this.nightLights.load(repaint);
    const galaxy = this.bindTexture(gl, this.milkyWay, MILKY_WAY_UNIT);
    const lights = wantsLights ? this.bindTexture(gl, this.nightLights, NIGHT_LIGHTS_UNIT) : 0;
    if (!wantsLights) this.unbindTexture(gl, NIGHT_LIGHTS_UNIT);
    if ((galaxy > 0 && galaxy < 1) || (lights > 0 && lights < 1)) repaint();

    // Keep MapLibre's depth test: opaque fills of the layers above are drawn
    // first and must not be painted over. Never write depth.
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
    gl.useProgram(this.skyProgram);
    gl.bindVertexArray(this.skyVao);
    gl.uniformMatrix4fv(sky.u_inverse, false, this.inverse);
    gl.uniform3fv(sky.u_sun, this.sun);
    gl.uniformMatrix3fv(sky.u_galactic, false, this.galactic);
    gl.uniform1f(sky.u_lighting, lighting ? 1 : 0);
    gl.uniform1f(sky.u_space, space);
    gl.uniform1f(sky.u_surface, surface);
    gl.uniform3f(sky.u_theme_sky, themeSky[0], themeSky[1], themeSky[2]);
    gl.uniform1f(
      sky.u_night,
      base === "satellite"
        ? NIGHT_BRIGHTNESS.satellite
        : dark
          ? NIGHT_BRIGHTNESS.mapDark
          : NIGHT_BRIGHTNESS.mapLight,
    );
    gl.uniform1f(sky.u_day_falloff, base === "satellite" ? 1 : 0);
    gl.uniform1f(sky.u_lights, lights);
    gl.uniform1f(sky.u_galaxy, galaxy);
    gl.uniform1i(sky.u_night_lights, NIGHT_LIGHTS_UNIT);
    gl.uniform1i(sky.u_milky_way, MILKY_WAY_UNIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (space > 0) {
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
      gl.useProgram(this.starProgram);
      gl.bindVertexArray(this.starVao);
      gl.uniformMatrix3fv(stars.u_matrix, false, this.skyMatrix);
      // The catalogue is in the galactic frame; the transpose turns it back.
      gl.uniformMatrix3fv(stars.u_to_globe, true, this.galactic);
      gl.uniform3fv(stars.u_camera, this.camera);
      gl.uniform1f(stars.u_pixel_ratio, map.getPixelRatio());
      gl.uniform1f(stars.u_opacity, space);
      gl.drawArrays(gl.POINTS, 0, STAR_COUNT);
    }
    gl.bindVertexArray(null);
    // MapLibre resets its cached GL state after a custom layer renders.
  }

  onRemove(): void {
    this.dispose();
  }

  dispose(): void {
    this.disposeGl();
    this.nightLights.dispose();
    this.milkyWay.dispose();
    this.map = null;
    this.gl = null;
  }

  /** The texture's fade-in, or 0 with the unit cleared while it is not ready. */
  private bindTexture(gl: WebGL2RenderingContext, texture: GlobeTexture, unit: number): number {
    if (texture.bind(gl, unit)) return texture.blend;
    this.unbindTexture(gl, unit);
    return 0;
  }

  /** Leave no unrelated MapLibre texture on a unit this program samples. */
  private unbindTexture(gl: WebGL2RenderingContext, unit: number): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private disposeGl(): void {
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
  }
}
