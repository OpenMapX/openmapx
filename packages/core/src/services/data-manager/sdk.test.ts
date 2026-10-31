import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { dataManagerOperations } from "./contracts";
import * as sdk from "./generated/data-manager.generated";
import { buildSearchIndexWithProgress, conflateOvertureWithProgress } from "./streams";
import { createDataManagerTransport, unwrapDataManagerResponse } from "./transport";

const streamHeaders = {
  "content-type": "application/x-ndjson",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};
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
  it("has a generated callable for all 61 explicit operations", () => {
    expect(Object.keys(dataManagerOperations)).toHaveLength(61);
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
  it("retains build provenance and rejects a terminal missing sourceFingerprint", async () => {
    const done = {
      event: "done",
      ok: true,
      region: "europe/germany",
      epoch: "e1",
      sourceFingerprint: "sha256:abc",
      placeCount: 1,
      termCount: 2,
    };
    const malformed = { ...done, sourceFingerprint: undefined };
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({ event: "progress", stage: "extract", message: "Extracting" })}\n${JSON.stringify(done)}\n`,
          { headers: streamHeaders },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(malformed), { headers: streamHeaders }));
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
    });
    const progress: string[] = [];
    expect(
      await buildSearchIndexWithProgress(
        { region: "europe/germany" },
        { transport, onProgress: (event) => progress.push(event.message) },
      ),
    ).toEqual(done);
    expect(progress).toEqual(["Extracting"]);
    await expect(
      buildSearchIndexWithProgress({ region: "europe/germany" }, { transport }),
    ).rejects.toThrow(/event contract/);
  });
  it("preserves valid unsuccessful Overture domain completion", async () => {
    const done = {
      event: "done",
      ok: false,
      linked: 0,
      status: "waiting_for_osm",
      pbfPath: "/data/osm",
    };
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(done), { headers: streamHeaders })),
    });
    expect(await conflateOvertureWithProgress({ region: "europe/germany" }, { transport })).toEqual(
      done,
    );
  });
  it("clears the header deadline while preserving observer cancellation on streams", async () => {
    const observer = new AbortController();
    let canceled = false;
    const acquire = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
        { headers: streamHeaders },
      ),
    );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      requestTimeoutMs: 5,
      signal: observer.signal,
      fetch: acquire,
    });
    const response = await sdk.buildSearchIndex({ region: "europe/germany" }, { transport });
    await new Promise((done) => setTimeout(done, 10));
    expect(acquire.mock.calls[0]?.[1].signal.aborted).toBe(false);
    if (!("stream" in response)) throw new Error("expected stream");
    const { readDataManagerNdjson } = await import("./stream-decoder");
    const pending = readDataManagerNdjson(
      response.stream,
      dataManagerOperations.buildSearchIndex.responses[200].schema,
    );
    observer.abort(new Error("observer left"));
    await expect(pending).rejects.toThrow("observer left");
    expect(canceled).toBe(true);
    expect(response.stream.body?.locked).toBe(false);
  });
});
