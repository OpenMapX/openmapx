import { describe, expect, it, vi } from "vitest";
import {
  fingerprintDataset,
  getSearchIndexStatus,
  updateCurrentSearchIndexFingerprint,
} from "../../src/jobs/search-index/state.js";

describe("search index state", () => {
  it("prefers registered checksums for fingerprints", async () => {
    await expect(
      fingerprintDataset({
        type: "osm-pbf",
        id: "de",
        region: "de",
        sizeBytes: 1,
        downloadedAt: "now",
        path: "/missing",
        sha256: "abc",
      }),
    ).resolves.toBe("sha256:abc");
  });

  it("updates only a matching live region", async () => {
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([]);
    await updateCurrentSearchIndexFingerprint({ unsafe } as never, "de", "md5:new");
    expect(unsafe.mock.calls[0]?.[0]).toContain("to_regclass");
    expect(unsafe.mock.calls[1]?.[0]).toContain("UPDATE osm_search.index_state");
    expect(unsafe.mock.calls[1]?.[1]).toEqual(["de", "md5:new"]);
  });

  it("does nothing when the live schema is absent", async () => {
    const unsafe = vi.fn().mockResolvedValue([{ exists: false }]);
    await updateCurrentSearchIndexFingerprint({ unsafe } as never, "de", "md5:new");
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it("returns an in-process failure when no live schema exists", async () => {
    const unsafe = vi.fn().mockResolvedValue([{ exists: false }]);
    const status = await getSearchIndexStatus({
      dataDir: "/data",
      store: { getAll: () => [] } as never,
      sql: { unsafe } as never,
      runtimeState: { building: false, failure: { region: "de", error: "boom", at: "now" } },
    });
    expect(status).toEqual(expect.objectContaining({ status: "failed", lastError: "boom" }));
  });
});
