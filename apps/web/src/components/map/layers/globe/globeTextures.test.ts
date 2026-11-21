import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobeTexture } from "./globeTextures";

function createGl() {
  return {
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    R8: 0x8229,
    RED: 0x1903,
    RGB8: 0x8051,
    RGB: 0x1907,
    UNSIGNED_BYTE: 0x1401,
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    activeTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    generateMipmap: vi.fn(),
    deleteTexture: vi.fn(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let bitmap: { close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  bitmap = { close: vi.fn() };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob(["image"]))),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GlobeTexture", () => {
  it("decodes in the background and uploads a single-channel texture during a render", async () => {
    const gl = createGl();
    const texture = new GlobeTexture("/globe/night-lights.webp", "r8");
    const ready = vi.fn();
    expect(texture.bind(gl as unknown as WebGL2RenderingContext, 0)).toBe(false);
    texture.load(ready);
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(gl.texImage2D).not.toHaveBeenCalled();

    expect(texture.bind(gl as unknown as WebGL2RenderingContext, 3)).toBe(true);
    expect(gl.activeTexture).toHaveBeenCalledWith(gl.TEXTURE0 + 3);
    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      gl.RED,
      gl.UNSIGNED_BYTE,
      bitmap,
    );
    expect(gl.generateMipmap).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);

    texture.bind(gl as unknown as WebGL2RenderingContext, 3);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
  });

  it("uploads colour textures as RGB", async () => {
    const gl = createGl();
    const texture = new GlobeTexture("/globe/milky-way.webp", "rgb8");
    texture.load(() => {});
    await flush();
    texture.bind(gl as unknown as WebGL2RenderingContext, 1);
    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      0,
      gl.RGB8,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      bitmap,
    );
  });

  it("fades in over 600 ms after the upload", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const texture = new GlobeTexture("/globe/milky-way.webp", "rgb8");
    texture.load(() => {});
    await flush();
    expect(texture.blend).toBe(0);
    texture.bind(createGl() as unknown as WebGL2RenderingContext, 0);
    now.mockReturnValue(1300);
    expect(texture.blend).toBeCloseTo(0.5);
    now.mockReturnValue(2000);
    expect(texture.blend).toBe(1);
  });

  it("gives up quietly when the image cannot be fetched", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const texture = new GlobeTexture("/globe/night-lights.webp", "r8");
    const ready = vi.fn();
    texture.load(ready);
    await flush();
    texture.load(ready);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    expect(texture.blend).toBe(0);
    expect(texture.bind(createGl() as unknown as WebGL2RenderingContext, 0)).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight request on dispose and never uploads into a released context", async () => {
    const gl = createGl();
    const texture = new GlobeTexture("/globe/night-lights.webp", "r8");
    texture.load(() => {});
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    texture.dispose();
    expect(signal?.aborted).toBe(true);
    await flush();
    expect(texture.bind(gl as unknown as WebGL2RenderingContext, 0)).toBe(false);
    expect(gl.texImage2D).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("releases the GPU texture on dispose and can load again afterwards", async () => {
    const gl = createGl();
    const texture = new GlobeTexture("/globe/milky-way.webp", "rgb8");
    texture.load(() => {});
    await flush();
    texture.bind(gl as unknown as WebGL2RenderingContext, 0);
    texture.dispose();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    texture.dispose();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    texture.load(() => {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
