import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfflinePackageApi, defaultOfflinePackageApi } from "./packageApi";

const packageId = `omp2-${"a".repeat(64)}`;

afterEach(() => vi.unstubAllGlobals());

describe("offline package API client", () => {
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
