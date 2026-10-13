import { describe, expect, it } from "vitest";
import {
  decodeRasterContributors,
  encodeRasterContributors,
  MAX_RASTER_IMAGE_BYTES,
  readRasterResponseBytes,
} from "./raster-contributors.js";

describe("raster response wire contract", () => {
  it("preserves Unicode and mandatory notice snapshots in an ASCII header", () => {
    const receipts = [
      {
        sourceId: "supplier",
        name: "© Énergie 日本",
        attributionText: "First notice\nsecond line",
        publisher: { name: "Publisher", url: "https://example.test" },
      },
    ];
    const header = encodeRasterContributors(receipts);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    receipts[0].publisher.name = "Changed";
    const decoded = decodeRasterContributors(header);
    expect(decoded[0]).toMatchObject({
      name: "© Énergie 日本",
      attributionText: "First notice\nsecond line",
      publisher: { name: "Publisher" },
    });
    expect(() =>
      encodeRasterContributors([{ sourceId: "large", name: "x".repeat(16385) }]),
    ).toThrow();
  });
  it("bounds actual streamed bytes even without Content-Length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RASTER_IMAGE_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readRasterResponseBytes(new Response(stream))).rejects.toThrow("exceeds limit");
    expect(cancelled).toBe(true);
  });
  it("supports empty and multi-chunk bodies without changing bytes", async () => {
    expect(await readRasterResponseBytes(new Response(null, { status: 204 }))).toEqual(
      new ArrayBuffer(0),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    expect(new Uint8Array(await readRasterResponseBytes(new Response(stream)))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
