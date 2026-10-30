import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOfflinePackageApi,
  defaultOfflinePackageApi,
  OfflinePackageApiError,
} from "./packageApi";

const packageId = `omp2-${"a".repeat(64)}`;
const request = {
  bbox: { west: 1, south: 1, east: 2, north: 2 },
  minZoom: 8,
  maxZoom: 14,
  provider: "openmapx",
} as const;
const canonicalRequest = {
  request,
  effective: { bbox: request.bbox, minZoom: 8, maxZoom: 14 },
  source: {
    datasetId: "openmapx",
    datasetVersion: "dataset-v1",
    sourceMaxZoom: 14,
    sourceBounds: { west: 0, south: 0, east: 10, north: 10 },
    tileSchema: "openmaptiles",
    glyphsVersion: "glyphs-v1",
    packageAlgorithmVersion: "pmtiles-area-v4",
    attribution: ["© OpenStreetMap contributors"],
  },
  requestKey: "fixture",
} as const;
const manifest = {
  schemaVersion: 2,
  packageId,
  requestKey: "fixture",
  dataset: {
    id: "openmapx",
    version: "dataset-v1",
    generatedAt: "2026-10-25T00:00:00.000Z",
    sourceMaxZoom: 14,
    tileSchema: "openmaptiles",
  },
  coverage: { bbox: request.bbox, minZoom: 8, maxZoom: 14 },
  archive: {
    url: `/api/offline/packages/${packageId}/archive`,
    contentType: "application/vnd.pmtiles",
    byteLength: 512,
    sha256: "a".repeat(64),
    etag: `sha256-${"a".repeat(64)}`,
  },
  glyphs: {
    version: "glyphs-v1",
    urlTemplate: "/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf",
  },
  attribution: ["© OpenStreetMap contributors"],
} as const;
const preparing = { jobId: "job-a", status: "preparing", packageId, request: canonicalRequest };
const available = {
  available: true,
  provider: "openmapx",
  datasetVersion: "dataset-v1",
  glyphsVersion: "glyphs-v1",
  sourceMaxZoom: 14,
  sourceBounds: canonicalRequest.source.sourceBounds,
};

afterEach(() => vi.unstubAllGlobals());

describe("offline package API client", () => {
  it.each([
    { available: true, provider: "openmapx" },
    { ...available, sourceMaxZoom: -1 },
    { ...available, sourceBounds: { west: 2, east: 1, south: 1, north: 2 } },
    { available: false, provider: "openmapx" },
    { available: false, provider: "openmapx", reason: "unexpected" },
    null,
  ])("rejects an incomplete or malformed capability: %j", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(createOfflinePackageApi().capability()).rejects.toMatchObject({
      name: "OfflinePackageApiError",
      code: "invalid-response",
      status: 200,
    });
  });

  it("returns complete available capabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(available)),
    );
    expect(await createOfflinePackageApi().capability()).toEqual(available);
  });

  describe.each(["prepare", "getJob"] as const)("%s response validation", (operation) => {
    const invoke = () =>
      operation === "prepare"
        ? createOfflinePackageApi().prepare(request)
        : createOfflinePackageApi().getJob("job-a");

    it.each([
      { status: "ready-to-download" },
      { ...preparing, request: undefined },
      { ...preparing, packageId: undefined },
      { ...preparing, status: "ready-to-download" },
      {
        ...preparing,
        status: "ready-to-download",
        manifest: { ...manifest, archive: { ...manifest.archive, sha256: "invalid" } },
      },
      { ...preparing, status: "failed" },
      { ...preparing, status: "expired", errorCode: "generation-failed", errorMessage: "expired" },
      { ...preparing, status: "unknown" },
      null,
    ])("rejects malformed successful jobs: %j", async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      await expect(invoke()).rejects.toMatchObject({
        name: "OfflinePackageApiError",
        code: "invalid-response",
        status: 200,
      });
    });

    it.each([
      preparing,
      { ...preparing, status: "ready-to-download", manifest },
      {
        jobId: "job-a",
        request: canonicalRequest,
        status: "failed",
        errorCode: "generation-failed",
        errorMessage: "Preparation failed",
      },
      {
        jobId: "job-a",
        request: canonicalRequest,
        status: "expired",
        errorCode: "expired",
        errorMessage: "Package expired",
      },
    ])("preserves complete %s job data", async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      expect(await invoke()).toEqual(body);
    });
  });

  it.each(["capability", "prepare", "getJob"] as const)(
    "%s does not reflect malformed response contents",
    async (operation) => {
      const secret = "private-diagnostic-do-not-reflect";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ diagnostic: secret })),
      );
      const api = createOfflinePackageApi();
      const result =
        operation === "prepare"
          ? api.prepare(request)
          : operation === "getJob"
            ? api.getJob("job-a")
            : api.capability();
      const error = await result.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(OfflinePackageApiError);
      expect(String(error)).not.toContain(secret);
    },
  );

  it("retains archive response ownership and cancellation signals", async () => {
    const controller = new AbortController();
    const response = new Response(new Uint8Array([1, 2, 3]), { status: 206 });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const returned = await createOfflinePackageApi().openArchive(
      packageId,
      undefined,
      controller.signal,
    );
    expect(returned).toBe(response);
    expect(returned.bodyUsed).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(new Uint8Array(await returned.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each(["capability", "prepare", "getJob"] as const)(
    "%s preserves AbortError identity",
    async (operation) => {
      const controller = new AbortController();
      controller.abort();
      const aborted = new DOMException("Aborted", "AbortError");
      const fetchMock = vi.fn(async () => {
        throw aborted;
      });
      vi.stubGlobal("fetch", fetchMock);
      const api = createOfflinePackageApi();
      const result =
        operation === "prepare"
          ? api.prepare(request, controller.signal)
          : operation === "getJob"
            ? api.getJob("job-a", controller.signal)
            : api.capability(controller.signal);
      await expect(result).rejects.toBe(aborted);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    },
  );

  it("sends credentials explicitly only for authenticated preparation and job status", async () => {
    const fetchMock = vi.fn(async () => Response.json(preparing, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createOfflinePackageApi("https://api.example.test");

    await api.prepare({
      bbox: { west: 1, south: 1, east: 2, north: 2 },
      minZoom: 8,
      maxZoom: 14,
      provider: "openmapx",
    });
    await api.getJob("job-a");

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "include" });
  });

  it.each([401, 403])(
    "surfaces authenticated preparation HTTP %s without retry metadata",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: "Authentication required" }, { status })),
      );
      const error = await createOfflinePackageApi()
        .prepare({
          bbox: { west: 1, south: 1, east: 2, north: 2 },
          minZoom: 8,
          maxZoom: 14,
          provider: "openmapx",
        })
        .catch((reason) => reason);
      expect(error).toMatchObject({ status, retryAfterSeconds: undefined });
    },
  );

  it("surfaces a bounded 429 retry delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            errorCode: "prepare-rate-limit",
            errorMessage: "Offline package preparation quota exceeded",
            retryAfterSeconds: 599,
          },
          { status: 429, headers: { "Retry-After": "599" } },
        ),
      ),
    );
    const error = await createOfflinePackageApi()
      .prepare({
        bbox: { west: 1, south: 1, east: 2, north: 2 },
        minZoom: 8,
        maxZoom: 14,
        provider: "openmapx",
      })
      .catch((reason) => reason);
    expect(error).toMatchObject({
      code: "prepare-rate-limit",
      status: 429,
      retryAfterSeconds: 599,
    });
  });

  it("pins resumed ranges to the immutable archive ETag", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    await defaultOfflinePackageApi.openArchive(packageId, {
      start: 1024,
      etag: `sha256-${"b".repeat(64)}`,
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/offline/packages/${packageId}/archive`, {
      headers: {
        Range: "bytes=1024-",
        "If-Range": `sha256-${"b".repeat(64)}`,
      },
      signal: undefined,
    });
  });

  it("uses the runtime API origin for every package request", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    await createOfflinePackageApi("https://api.example.test/").openArchive(packageId);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/api/offline/packages/${packageId}/archive`,
    );
  });

  it("accepts a typed unavailable capability from a failed public proxy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { available: false, provider: "openmapx", reason: "source-unavailable" },
          { status: 502 },
        ),
      ),
    );

    expect(await defaultOfflinePackageApi.capability()).toEqual({
      available: false,
      provider: "openmapx",
      reason: "source-unavailable",
    });
  });
});
