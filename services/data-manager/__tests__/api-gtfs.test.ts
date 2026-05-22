import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDownloadGtfs = vi.fn();
const mockRunTransitousPipeline = vi.fn();
const mockBuildJobContext = vi.fn();
const mockToDownloadGtfsResult = vi.fn();

vi.mock("../src/jobs/download-gtfs.js", () => ({
  downloadGtfs: mockDownloadGtfs,
}));

vi.mock("../src/jobs/transitous/index.js", () => ({
  buildJobContext: mockBuildJobContext,
  runTransitousPipeline: mockRunTransitousPipeline,
  toDownloadGtfsResult: mockToDownloadGtfsResult,
}));

const { registerApi } = await import("../src/api.js");

describe("data-manager GTFS API", () => {
  beforeEach(() => {
    mockDownloadGtfs.mockReset();
    mockRunTransitousPipeline.mockReset();
    mockBuildJobContext.mockReset();
    mockToDownloadGtfsResult.mockReset();
    mockBuildJobContext.mockImplementation((opts) => ({
      jobId: "test-job",
      ...opts,
      state: {},
    }));
    mockRunTransitousPipeline.mockResolvedValue({
      jobId: "test-job",
      results: [],
      finalStatus: "ok",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("returns partial-success GTFS download details when some feeds fail", async () => {
    mockToDownloadGtfsResult.mockReturnValue({
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

    expect(mockRunTransitousPipeline).toHaveBeenCalledTimes(1);
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
    expect(mockRunTransitousPipeline).not.toHaveBeenCalled();
    expect(mockDownloadGtfs).not.toHaveBeenCalled();

    await app.close();
  });
});
