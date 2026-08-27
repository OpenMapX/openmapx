import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfflinePackageApi, defaultOfflinePackageApi } from "./packageApi";

const packageId = `omp2-${"a".repeat(64)}`;

afterEach(() => vi.unstubAllGlobals());

describe("offline package API client", () => {
  it("sends credentials explicitly only for authenticated preparation and job status", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ jobId: "job-a", status: "preparing" }, { status: 202 }),
    );
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
