import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { dataManagerOperations } from "./contracts";
import * as sdk from "./generated/data-manager.generated";
import { createDataManagerTransport, unwrapDataManagerResponse } from "./transport";

describe("generated complete internal data-manager SDK", () => {
  it("exposes only void data for every generated explicit HEAD status", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof sdk.headOfflinePackageArchive>>["data"]
    >().toEqualTypeOf<void>();
    expectTypeOf<Awaited<ReturnType<typeof sdk.headOfflineGlyph>>["data"]>().toEqualTypeOf<void>();
    expectTypeOf<
      Extract<Awaited<ReturnType<typeof sdk.getOfflinePackageArchive>>, { status: 416 }>["data"]
    >().toEqualTypeOf<void>();
  });
  it("has a generated callable for every declared internal operation", () => {
    for (const key of Object.keys(dataManagerOperations))
      expect(sdk).toHaveProperty(key, expect.any(Function));
  });
  it("preserves dataset metadata, including md5, without inventing defaults", async () => {
    const dataset = {
      type: "osm-pbf",
      id: "osm",
      sizeBytes: 1,
      downloadedAt: "2026-10-19T00:00:00Z",
      path: "/data/osm",
      md5: "digest",
    };
    const transport = createDataManagerTransport({
      baseUrl: "https://data-manager.example",
      fetch: vi.fn().mockResolvedValue(Response.json({ datasets: [dataset] })),
    });
    expect(unwrapDataManagerResponse(await sdk.getDatasets({ transport }))).toEqual({
      datasets: [dataset],
    });
  });
  it("uses generated closure identity even when an untyped caller forges protocol metadata", async () => {
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: vi.fn().mockResolvedValue(Response.json({ ok: true })),
    });
    await expect(
      sdk.reloadDatasets({
        transport,
        contractId: "getLive",
        operationId: "getLive",
        kind: "raw",
      } as never),
    ).rejects.toThrow(/contract/);
  });
  it("validates required raw metadata and retains the unconsumed glyph response", async () => {
    const headers = {
      "content-type": "application/x-protobuf",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": "3",
    };
    const raw = new Response("pbf", { headers });
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce(
        new Response("pbf", { headers: { "content-type": "application/x-protobuf" } }),
      );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
    });
    const result = await sdk.getOfflineGlyph("v1", "Noto Sans,街?", "0-255", { transport });
    expect(unwrapDataManagerResponse(result)).toBe(raw);
    expect(raw.bodyUsed).toBe(false);
    expect(acquire.mock.calls[0]?.[0]).toBe(
      "http://data-manager/offline/packages/glyphs/v1/Noto%20Sans%2C%E8%A1%97%3F/0-255.pbf",
    );
    await raw.body?.cancel();
    await expect(sdk.getOfflineGlyph("v1", "Noto", "0-255", { transport })).rejects.toThrow(
      /headers/,
    );
  });
  it("clears the header deadline while preserving observer cancellation on raw responses", async () => {
    const observer = new AbortController();
    const acquire = vi.fn().mockResolvedValue(
      new Response("pbf", {
        headers: {
          "content-type": "application/x-protobuf",
          "cache-control": "public, max-age=31536000, immutable",
          "content-length": "3",
        },
      }),
    );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      requestTimeoutMs: 5,
      signal: observer.signal,
      fetch: acquire,
    });
    const raw = unwrapDataManagerResponse(
      await sdk.getOfflineGlyph("v1", "Noto", "0-255", { transport }),
    );
    await new Promise((done) => setTimeout(done, 10));
    const signal: AbortSignal = acquire.mock.calls[0]?.[1].signal;
    expect(signal.aborted).toBe(false);
    observer.abort(new Error("observer left"));
    expect(signal.aborted).toBe(true);
    expect(raw.bodyUsed).toBe(false);
  });
});
