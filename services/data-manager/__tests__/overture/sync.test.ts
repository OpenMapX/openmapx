import { describe, expect, it, vi } from "vitest";
import { syncOvertureRegion } from "../../src/jobs/overture/sync.js";

const OPTIONS = {
  region: "europe/germany/berlin",
  dataDir: "/data",
  release: "2026-07-22.0",
};

function dependencies(rebuildStatus: "completed" | "waiting_for_osm" | "failed" = "completed") {
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
      withOperationLock: vi.fn(<T>(operation: () => Promise<T>) => operation()),
      finalizeReleaseFiles: vi.fn(async () => {
        calls.push("prune");
        return { retained: [OPTIONS.release], removed: [] };
      }),
      rebuildLinks: vi.fn(async () => {
        calls.push("rebuild");
        if (rebuildStatus === "failed") {
          return {
            status: "failed" as const,
            linked: 0,
            phase: "score" as const,
            error: "scoring failed",
          };
        }
        if (rebuildStatus === "waiting_for_osm") {
          return {
            status: "waiting_for_osm" as const,
            linked: 0,
            pbfPath: "/data/osm/berlin.osm.pbf",
          };
        }
        return {
          status: "completed" as const,
          linked: 17,
          emitted: 35,
          extracted: 30,
          candidates: 20,
          components: 18,
          phaseDurationsMs: {},
        };
      }),
    },
  };
}

describe("syncOvertureRegion", () => {
  it("pulls and atomically ingests the same resolved release before rebuilding links", async () => {
    const deps = dependencies();
    const result = await syncOvertureRegion(OPTIONS, deps.value as never);
    expect(deps.calls).toEqual(["pull", "ingest", "rebuild", "prune"]);
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
      retention: { retained: [OPTIONS.release], removed: [] },
    });
  });

  it("keeps the place refresh successful when no optional regional OSM PBF exists", async () => {
    const deps = dependencies("waiting_for_osm");
    const result = await syncOvertureRegion(OPTIONS, deps.value as never);
    expect(deps.calls).toEqual(["pull", "ingest", "rebuild"]);
    expect(deps.value.finalizeReleaseFiles).not.toHaveBeenCalled();
    expect(result.conflation).toBe("waiting_for_osm");
  });

  it("publishes Places successfully when the independent link rebuild fails", async () => {
    const deps = dependencies("failed");
    const result = await syncOvertureRegion(OPTIONS, deps.value as never);
    expect(deps.calls).toEqual(["pull", "ingest", "rebuild"]);
    expect(deps.value.finalizeReleaseFiles).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        release: OPTIONS.release,
        conflation: "failed",
        linked: 0,
        conflationError: "scoring failed",
      }),
    );
  });

  it("never ingests when the regional pull fails", async () => {
    const deps = dependencies();
    deps.value.pull.mockRejectedValueOnce(new Error("download failed"));
    await expect(syncOvertureRegion(OPTIONS, deps.value as never)).rejects.toThrow(
      "download failed",
    );
    expect(deps.value.ingest).not.toHaveBeenCalled();
  });
});
