import { expect, it } from "vitest";
import { rasterPayloadOpacity } from "./rasterPayloadOpacity";

it("uses actual decoded-format evidence, never extension/header/remote certificates", () => {
  expect(rasterPayloadOpacity(new ArrayBuffer(0))).toBe("transparent");
  expect(rasterPayloadOpacity(new Uint8Array([255, 216, 255, 217]).buffer)).toBe("unknown");
  expect(rasterPayloadOpacity(new TextEncoder().encode("not a jpeg").buffer)).toBe("unknown");
  const jpeg = new Uint8Array([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1,
    255, 217,
  ]);
  expect(rasterPayloadOpacity(jpeg.buffer)).toBe("opaque");
});

import { afterEach, vi } from "vitest";
import { inspectRasterPayloadOpacity } from "./rasterPayloadOpacity";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function png() {
  const data = new Uint8Array(33);
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  data.set([73, 72, 68, 82], 12);
  new DataView(data.buffer).setUint32(16, 2);
  new DataView(data.buffer).setUint32(20, 1);
  return data.buffer;
}
it.each([
  [0, 0, "transparent"],
  [255, 255, "opaque"],
  [0, 255, "nonopaque"],
  [128, 128, "nonopaque"],
] as const)("inspects exact decoded PNG alpha %s/%s", async (a, b, expected) => {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 2, height: 1, close })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, a, 1, 2, 3, b]) }),
  } as unknown as CanvasRenderingContext2D);
  expect(await inspectRasterPayloadOpacity(png())).toBe(expected);
  expect(close).toHaveBeenCalledTimes(1);
});
it("keeps unavailable/failed decoder and oversized image unknown", async () => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      throw new Error("decode");
    }),
  );
  expect(await inspectRasterPayloadOpacity(png())).toBe("unknown");
  const huge = png();
  new DataView(huge).setUint32(16, 99999);
  expect(await inspectRasterPayloadOpacity(huge)).toBe("unknown");
  expect(createImageBitmap).toHaveBeenCalledTimes(1);
});
