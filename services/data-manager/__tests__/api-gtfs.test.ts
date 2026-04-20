import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDownloadGtfs = vi.fn();
const mockDownloadGtfsViaTransitous = vi.fn();

vi.mock("../src/jobs/download-gtfs.js", () => ({
  downloadGtfs: mockDownloadGtfs,
}));

vi.mock("../src/jobs/transitous-pipeline.js", () => ({
  downloadGtfsViaTransitous: mockDownloadGtfsViaTransitous,
}));

const { registerApi } = await import("../src/api.js");

describe("data-manager GTFS API", () => {
  beforeEach(() => {
    mockDownloadGtfs.mockReset();
    mockDownloadGtfsViaTransitous.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("returns partial-success GTFS download details when some feeds fail", async () => {
    mockDownloadGtfsViaTransitous.mockResolvedValue({
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
      usedTransitousPipeline: true,
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

    expect(mockDownloadGtfsViaTransitous).toHaveBeenCalledTimes(1);
    expect(mockDownloadGtfs).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects an explicit empty feeds array unless source=transitous is set", async () => {
    const app = Fastify();
    registerApi(app, { dataDir: "/tmp/openmapx-dm-gtfs-api" });

    const res = await app.inject({
      method: "POST",
      url: "/download/gtfs",
      payload: { feeds: [], countries: ["de"] },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("either `feeds` or `source: 'transitous'` is required");
    expect(mockDownloadGtfsViaTransitous).not.toHaveBeenCalled();
    expect(mockDownloadGtfs).not.toHaveBeenCalled();

    await app.close();
  });
});
