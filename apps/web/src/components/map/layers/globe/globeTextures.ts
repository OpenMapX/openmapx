export const NIGHT_LIGHTS_URL = "/globe/night-lights.webp";
export const MILKY_WAY_URL = "/globe/milky-way.webp";

const FADE_IN_MS = 600;

/**
 * An equirectangular image for the globe, fetched once and uploaded with
 * mipmaps. Decoding happens in the background, but the upload waits for the
 * next render: MapLibre caches GL bindings and only expects them to change
 * while a custom layer is rendering. A failed fetch is not retried; the
 * feature that needs the image is simply left out.
 */
export class GlobeTexture {
  private request: AbortController | null = null;
  private pending: ImageBitmap | null = null;
  private texture: WebGLTexture | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private uploadedAt: number | null = null;
  private failed = false;

  constructor(
    private readonly url: string,
    private readonly format: "r8" | "rgb8",
  ) {}

  /** Start fetching unless the image is loading, loaded or has failed. */
  load(onReady: () => void): void {
    if (this.request || this.pending || this.texture || this.failed) return;
    const request = new AbortController();
    this.request = request;
    fetch(this.url, { signal: request.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Globe texture ${this.url}: HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob, { colorSpaceConversion: "none" }))
      .then((bitmap) => {
        if (request.signal.aborted) {
          bitmap.close();
          return;
        }
        this.pending = bitmap;
        onReady();
      })
      .catch((error: unknown) => {
        if (request.signal.aborted) return;
        this.failed = true;
        console.warn("Unable to load globe texture", error);
      })
      .finally(() => {
        if (this.request === request) this.request = null;
      });
  }

  /**
   * Bind to the given texture unit, uploading a decoded image first. Returns
   * false while there is nothing to sample yet.
   */
  bind(gl: WebGL2RenderingContext, unit: number): boolean {
    if (this.pending) this.upload(gl, this.pending);
    if (!this.texture) return false;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    return true;
  }

  /** 0 until uploaded, then rising to 1 so the feature does not pop in. */
  get blend(): number {
    if (this.uploadedAt === null) return 0;
    return Math.min(1, (performance.now() - this.uploadedAt) / FADE_IN_MS);
  }

  dispose(): void {
    this.request?.abort();
    this.request = null;
    this.pending?.close();
    this.pending = null;
    if (this.gl && this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.gl = null;
    this.uploadedAt = null;
    this.failed = false;
  }

  private upload(gl: WebGL2RenderingContext, bitmap: ImageBitmap): void {
    this.pending = null;
    const texture = gl.createTexture();
    if (!texture) {
      bitmap.close();
      this.failed = true;
      return;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const [internalFormat, format] = this.format === "r8" ? [gl.R8, gl.RED] : [gl.RGB8, gl.RGB];
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, format, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Longitude wraps around the sphere; latitude stops at the poles.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    bitmap.close();
    this.texture = texture;
    this.gl = gl;
    this.uploadedAt = performance.now();
  }
}
