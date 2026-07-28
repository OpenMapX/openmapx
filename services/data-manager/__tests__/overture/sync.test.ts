import { describe, expect, it, vi } from "vitest";
import { syncOvertureRegion } from "../../src/jobs/overture/sync.js";

const OPTIONS = {
  region: "europe/germany/berlin",
  dataDir: "/data",
  release: "2026-07-22.0",
};

function dependencies(fileExists = true) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      pull: vi.fn(async () => {
        calls.push("pull");
        return "/data/overture/2026-07-22.0/europe-germany-berlin.parquet";
      }),
      ingest: vi.fn(async () => {
        calls.push("ingest");
      }),
      extract: vi.fn(async () => {
        calls.push("extract");
        return [];
      }),
      conflate: vi.fn(async () => {
        calls.push("conflate");
        return { linked: 17, skipped: 0, pruned: 0 };
      }),
      fileExists: vi.fn(() => fileExists),
    },
  };
}

describe("syncOvertureRegion", () => {
  it("pulls and atomically ingests the same resolved release before rebuilding links", async () => {
    const deps = dependencies();
    const result = await syncOvertureRegion(OPTIONS, deps.value);
    expect(deps.calls).toEqual(["pull", "ingest", "extract", "conflate"]);
    expect(deps.value.pull).toHaveBeenCalledWith(
      expect.objectContaining({ release: OPTIONS.release }),
    );
    expect(deps.value.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ release: OPTIONS.release }),
    );
    expect(result).toEqual({
      release: OPTIONS.release,
      path: "/data/overture/2026-07-22.0/europe-germany-berlin.parquet",
      conflation: "completed",
      linked: 17,
    });
  });

  it("keeps the place refresh successful when no optional regional OSM PBF exists", async () => {
    const deps = dependencies(false);
    const result = await syncOvertureRegion(OPTIONS, deps.value);
    expect(deps.calls).toEqual(["pull", "ingest"]);
    expect(result.conflation).toBe("skipped");
  });

  it("never ingests when the regional pull fails", async () => {
    const deps = dependencies();
    deps.value.pull.mockRejectedValueOnce(new Error("download failed"));
    await expect(syncOvertureRegion(OPTIONS, deps.value)).rejects.toThrow("download failed");
    expect(deps.value.ingest).not.toHaveBeenCalled();
  });
});
