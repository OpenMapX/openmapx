import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultOfflinePackageApi } from "./packageApi";

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
});
