import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { offlinePackagesRoute } from "../offline-packages.js";

const packageId = `omp2-${"a".repeat(64)}`;
const archive = new TextEncoder().encode("pmtiles-fixture");
const manifest = {
  schemaVersion: 2,
  packageId,
  requestKey: "fixture",
  dataset: {
    id: "openmapx",
    version: "dataset-v1",
    generatedAt: "2026-08-03T00:00:00.000Z",
    sourceMaxZoom: 14,
    tileSchema: "openmaptiles",
  },
  coverage: { bbox: { west: 0, south: 0, east: 10, north: 10 }, minZoom: 1, maxZoom: 14 },
  archive: {
    url: `/api/offline/packages/${packageId}/archive`,
    contentType: "application/vnd.pmtiles",
    byteLength: archive.byteLength,
    sha256: "a".repeat(64),
    etag: `sha256-${"a".repeat(64)}`,
  },
  glyphs: {
    version: "glyphs-v1",
    urlTemplate: "/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf",
  },
  attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
} as const;

const request = {
  bbox: { west: 1, south: 1, east: 2, north: 2 },
  minZoom: 8,
  maxZoom: 14,
  provider: "openmapx",
};

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("offline package public API", () => {
  it("validates requests and proxies capability, preparation, and manifests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/offline/packages/capability")) {
        return jsonResponse({ available: true, provider: "openmapx", sourceMaxZoom: 14 });
      }
      if (url.endsWith("/offline/packages/prepare")) {
        expect(init?.body).toBe(JSON.stringify(request));
        return jsonResponse({ status: "ready-to-download", request, manifest, packageId }, 200);
      }
      if (url.endsWith(`/offline/packages/${packageId}/manifest`)) return jsonResponse(manifest);
      if (url.endsWith("/offline/packages/glyphs/glyphs-v1/catalog.json")) {
        return jsonResponse({ Metropolis: ["0-255"] });
      }
      if (url.includes("/offline/packages/glyphs/glyphs-v1/")) {
        return new Response("fixture-font", {
          status: 200,
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-length": "12",
            "content-type": "application/x-protobuf",
            etag: "asset-v1",
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = Fastify();
    await app.register(offlinePackagesRoute);

    const capability = await app.inject({ method: "GET", url: "/offline/packages/capability" });
    expect(capability.statusCode).toBe(200);
    expect(capability.json().provider).toBe("openmapx");

    const invalid = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      payload: { ...request, provider: "maptiler" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const prepared = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      payload: request,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().manifest.archive.byteLength).toBe(archive.byteLength);

    const manifestResponse = await app.inject({
      method: "GET",
      url: `/offline/packages/${packageId}/manifest`,
    });
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json().glyphs.version).toBe("glyphs-v1");

    const catalog = await app.inject({
      method: "GET",
      url: "/offline/packages/glyphs/glyphs-v1/catalog.json",
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual({ Metropolis: ["0-255"] });

    const assetHead = await app.inject({
      method: "HEAD",
      url: "/offline/packages/glyphs/glyphs-v1/Metropolis/0-255.pbf",
    });
    expect(assetHead.statusCode).toBe(200);
    expect(assetHead.headers.etag).toBe("asset-v1");
    const asset = await app.inject({
      method: "GET",
      url: "/offline/packages/glyphs/glyphs-v1/Metropolis/0-255.pbf",
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("fixture-font");

    const traversal = await app.inject({
      method: "GET",
      url: "/offline/packages/not-a-valid-id/manifest",
    });
    expect(traversal.statusCode).toBe(400);
    await app.close();
  });

  it("forwards archive HEAD and range responses without buffering them", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Range: "bytes=2-" });
      return new Response(
        Readable.toWeb(Readable.from(Buffer.from(archive.slice(2)))) as ReadableStream,
        {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(archive.byteLength - 2),
            "content-range": `bytes 2-${archive.byteLength - 1}/${archive.byteLength}`,
            "content-type": "application/vnd.pmtiles",
            etag: manifest.archive.etag,
            "cache-control": "public, max-age=31536000, immutable",
          },
        },
      );
    });
    const app = Fastify();
    await app.register(offlinePackagesRoute);

    const response = await app.inject({
      method: "GET",
      url: `/offline/packages/${packageId}/archive`,
      headers: { range: "bytes=2-" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(
      `bytes 2-${archive.byteLength - 1}/${archive.byteLength}`,
    );
    expect(response.rawPayload).toEqual(Buffer.from(archive.slice(2)));

    const missing = await app.inject({
      method: "GET",
      url: `/offline/packages/${"b".repeat(70)}/archive`,
    });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });
});
