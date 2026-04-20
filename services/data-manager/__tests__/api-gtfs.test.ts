import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDownloadGtfs = vi.fn();
const mockResolveTransitousFeedCatalog = vi.fn();

vi.mock("../src/jobs/download-gtfs.js", () => ({
  downloadGtfs: mockDownloadGtfs,
}));

vi.mock("../src/jobs/transitous-feed-resolver.js", () => ({
  resolveTransitousFeedCatalog: mockResolveTransitousFeedCatalog,
}));

const { registerApi } = await import("../src/api.js");

describe("data-manager GTFS API", () => {
  beforeEach(() => {
    mockDownloadGtfs.mockReset();
    mockResolveTransitousFeedCatalog.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("returns partial-success GTFS download details when some feeds fail", async () => {
    mockResolveTransitousFeedCatalog.mockResolvedValue([
      { id: "de_bvg", country: "de", url: "https://example.com/de_bvg.zip" },
      { id: "de_vbb", country: "de", url: "https://example.com/de_vbb.zip" },
    ]);
    mockDownloadGtfs.mockResolvedValue({
      requestedCount: 2,
      selectedCount: 2,
      skippedCount: 0,
      downloaded: [
        {
          type: "gtfs",
          id: "de_bvg",
          url: "https://example.com/de_bvg.zip",
          sizeBytes: 123,
          downloadedAt: "2026-04-20T10:00:00.000Z",
          path: "/tmp/de_bvg.zip",
        },
      ],
      failures: [
        {
          id: "de_vbb",
          country: "de",
          url: "https://example.com/de_vbb.zip",
          message: "HTTP 503",
        },
      ],
      partialSuccess: true,
    });

    const app = Fastify();
    registerApi(app, { dataDir: "/tmp/openmapx-dm-gtfs-api" });

    const res = await app.inject({
      method: "POST",
      url: "/download/gtfs",
      payload: { source: "transitous", countries: ["de"] },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      count: 1,
      resolvedFromCatalog: true,
      requestedCount: 2,
      selectedCount: 2,
      skippedCount: 0,
      failedCount: 1,
      partialSuccess: true,
      failures: [
        {
          id: "de_vbb",
          country: "de",
          url: "https://example.com/de_vbb.zip",
          message: "HTTP 503",
        },
      ],
    });

    expect(mockResolveTransitousFeedCatalog).toHaveBeenCalledTimes(1);
    expect(mockDownloadGtfs).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
