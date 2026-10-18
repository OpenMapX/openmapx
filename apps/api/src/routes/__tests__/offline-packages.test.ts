import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: "user-a" as string | null }));
vi.mock("../../utils/require-auth.js", () => ({
  requireAuthHook: vi.fn(async (request: { userId?: string }) => {
    if (!auth.userId)
      throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    request.userId = auth.userId;
  }),
  getUserId: vi.fn((request: { userId?: string }) => {
    if (!request.userId) throw new Error("missing authenticated user");
    return request.userId;
  }),
}));

const { createOfflinePackagesRoute } = await import("../offline-packages.js");

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

const canonicalRequest = {
  request,
  effective: { bbox: request.bbox, minZoom: request.minZoom, maxZoom: request.maxZoom },
  source: {
    datasetId: "openmapx",
    datasetVersion: "dataset-v1",
    sourceMaxZoom: 14,
    sourceBounds: { west: 0, south: 0, east: 10, north: 10 },
    tileSchema: "openmaptiles",
    glyphsVersion: "glyphs-v1",
    packageAlgorithmVersion: "pmtiles-area-v4",
    attribution: [...manifest.attribution],
  },
  requestKey: "fixture",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  auth.userId = "user-a";
});

function routeOptions() {
  return {
    principalKey: Buffer.alloc(32, 7),
    prepareLimiter: {
      consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("offline package public API", () => {
  it("rejects an unsafe internal destination without sending service credentials", async () => {
    vi.stubEnv("DATA_MANAGER_URL", "http://untrusted.example.test:4000");
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "private-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        available: true,
        provider: "openmapx",
      }),
    );
    const app = Fastify();
    await app.register(createOfflinePackagesRoute(routeOptions()));
    const response = await app.inject({ method: "GET", url: "/offline/packages/capability" });
    expect(response.statusCode).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
  it("validates requests and proxies capability, preparation, and manifests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/offline/packages/capability")) {
        return jsonResponse({
          available: true,
          provider: "openmapx",
          sourceMaxZoom: 14,
          datasetVersion: "dataset-v1",
          glyphsVersion: "glyphs-v1",
          sourceBounds: canonicalRequest.source.sourceBounds,
        });
      }
      if (url.endsWith("/offline/packages/prepare")) {
        expect(init?.body).toBe(JSON.stringify(request));
        expect(new Headers(init?.headers).get("x-offline-package-principal")).toMatch(
          /^[a-f0-9]{64}$/,
        );
        expect(JSON.stringify(init)).not.toContain("user-a");
        return jsonResponse(
          {
            jobId: "job-a",
            status: "ready-to-download",
            request: canonicalRequest,
            manifest,
            packageId,
          },
          200,
        );
      }
      if (url.endsWith(`/offline/packages/${packageId}/manifest`)) return jsonResponse(manifest);
      if (url.endsWith("/offline/packages/glyphs/glyphs-v1/catalog.json")) {
        return Response.json(
          { Metropolis: ["0-255"] },
          { headers: { "cache-control": "public, max-age=31536000, immutable" } },
        );
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
    await app.register(createOfflinePackagesRoute(routeOptions()));

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

  it("requires a session only for prepare and job status and binds the same opaque principal", async () => {
    const upstreamHeaders: Array<Record<string, string>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/offline/packages/capability")) {
        return jsonResponse({
          available: true,
          provider: "openmapx",
          sourceMaxZoom: 14,
          datasetVersion: "dataset-v1",
          glyphsVersion: "glyphs-v1",
          sourceBounds: canonicalRequest.source.sourceBounds,
        });
      }
      upstreamHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return jsonResponse(
        { jobId: "job-a", status: "preparing", packageId, request: canonicalRequest },
        url.endsWith("/offline/packages/prepare") ? 202 : 200,
      );
    });
    const options = routeOptions();
    const app = Fastify();
    await app.register(createOfflinePackagesRoute(options));

    auth.userId = null;
    expect(
      (await app.inject({ method: "POST", url: "/offline/packages/prepare", payload: request }))
        .statusCode,
    ).toBe(401);
    const anonymousJob = await app.inject({
      method: "GET",
      url: "/offline/packages/jobs/job-a",
    });
    expect(anonymousJob.statusCode).toBe(401);
    expect(anonymousJob.headers["cache-control"]).toBe("private, no-store");
    expect(anonymousJob.headers.pragma).toBe("no-cache");
    expect(anonymousJob.headers["referrer-policy"]).toBe("no-referrer");
    expect(anonymousJob.headers.vary).toContain("Cookie");
    expect(
      (await app.inject({ method: "GET", url: "/offline/packages/capability" })).statusCode,
    ).toBe(200);
    expect(upstreamHeaders).toHaveLength(0);

    auth.userId = "user-a";
    expect(
      (await app.inject({ method: "POST", url: "/offline/packages/prepare", payload: request }))
        .statusCode,
    ).toBe(202);
    expect(
      (await app.inject({ method: "GET", url: "/offline/packages/jobs/job-a" })).statusCode,
    ).toBe(200);
    expect(upstreamHeaders).toHaveLength(2);
    expect(upstreamHeaders[0]?.["x-offline-package-principal"]).toBe(
      upstreamHeaders[1]?.["x-offline-package-principal"],
    );
    expect(JSON.stringify(upstreamHeaders)).not.toContain("user-a");
    await app.close();
  });

  it("counts authenticated prepare calls independently of IP and returns bounded retry metadata", async () => {
    const options = routeOptions();
    options.prepareLimiter.consume
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 599 })
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse(
        { jobId: "job", status: "preparing", packageId, request: canonicalRequest },
        202,
      ),
    );
    const app = Fastify({ trustProxy: true });
    await app.register(createOfflinePackagesRoute(options));

    for (const ip of ["198.51.100.1", "198.51.100.2"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/offline/packages/prepare",
            headers: { "x-forwarded-for": ip },
            payload: request,
          })
        ).statusCode,
      ).toBe(202);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      headers: { "x-forwarded-for": "198.51.100.3" },
      payload: request,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("599");
    expect(limited.json()).toEqual({
      ok: false,
      errorCode: "prepare-rate-limit",
      errorMessage: "Offline package preparation quota exceeded",
      retryAfterSeconds: 599,
    });
    expect(options.prepareLimiter.consume).toHaveBeenCalledTimes(3);
    auth.userId = "user-b";
    const independent = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      headers: { "x-forwarded-for": "198.51.100.3" },
      payload: request,
    });
    expect(independent.statusCode).toBe(202);
    expect(options.prepareLimiter.consume).toHaveBeenCalledTimes(4);
    expect(options.prepareLimiter.consume.mock.calls[3]?.[0]).not.toBe(
      options.prepareLimiter.consume.mock.calls[0]?.[0],
    );
    await app.close();
  });

  it("charges authenticated duplicates and rejected request bodies before allocation", async () => {
    const options = routeOptions();
    options.prepareLimiter.consume
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 600 });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const app = Fastify();
    await app.register(createOfflinePackagesRoute(options));

    const invalid = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      payload: { ...request, provider: "caller-selected-provider" },
    });
    expect(invalid.statusCode).toBe(400);

    const next = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      payload: request,
    });
    expect(next.statusCode).toBe(429);
    expect(options.prepareLimiter.consume).toHaveBeenCalledTimes(2);
    expect(options.prepareLimiter.consume.mock.calls[1]?.[0]).toBe(
      options.prepareLimiter.consume.mock.calls[0]?.[0],
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves a bounded data-manager Retry-After without exposing principal material", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          errorCode: "principal-quota",
          errorMessage: "Offline package preparation quota exceeded",
          retryAfterSeconds: 30,
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        },
      ),
    );
    const app = Fastify();
    await app.register(createOfflinePackagesRoute(routeOptions()));

    const response = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      payload: request,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).not.toContain("user-a");
    expect(response.body).not.toContain(Buffer.alloc(32, 7).toString("base64url"));
    await app.close();
  });

  it("forwards explicit archive HEAD, If-Range and unsatisfiable ranges", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("range")).toBe("bytes=999-");
      expect(headers.get("if-range")).toBe('"archive-v1"');
      expect(init?.method).toBe("HEAD");
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${archive.byteLength}`,
          "accept-ranges": "bytes",
          etag: manifest.archive.etag,
        },
      });
    });
    const app = Fastify();
    await app.register(createOfflinePackagesRoute(routeOptions()));
    const response = await app.inject({
      method: "HEAD",
      url: `/offline/packages/${packageId}/archive`,
      headers: { range: "bytes=999-", "if-range": '"archive-v1"' },
    });
    expect(response.statusCode).toBe(416);
    expect(response.body).toBe("");
    expect(response.headers["content-range"]).toBe(`bytes */${archive.byteLength}`);
    expect(response.headers.etag).toBe(manifest.archive.etag);
    expect(fetch).toHaveBeenCalledOnce();
    await app.close();
  });

  it("uses encoded named glyph parameters for spaces, commas and Unicode", async () => {
    const fontstack = "Noto Sans,中文字";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toContain(
        `/glyphs/glyphs-v1/${encodeURIComponent(fontstack)}/0-255.pbf`,
      );
      expect(init?.redirect).toBe("error");
      return new Response("glyph", {
        headers: {
          "content-type": "application/x-protobuf",
          "content-length": "5",
          "cache-control": "public, max-age=31536000, immutable",
          etag: "glyph-v1",
        },
      });
    });
    const app = Fastify();
    await app.register(createOfflinePackagesRoute(routeOptions()));
    const response = await app.inject({
      method: "GET",
      url: `/offline/packages/glyphs/glyphs-v1/${encodeURIComponent(fontstack)}/0-255.pbf`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("glyph");
    expect(response.headers.etag).toBe("glyph-v1");
    await app.close();
  });

  it("forwards archive range responses without buffering them", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=2-");
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
    await app.register(createOfflinePackagesRoute(routeOptions()));

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
