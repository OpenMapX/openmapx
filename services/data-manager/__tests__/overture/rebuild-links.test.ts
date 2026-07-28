import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ unsafe: vi.fn() }));

vi.mock("../../src/db/index.js", () => ({
  sql: { unsafe: mocks.unsafe },
}));

import { rebuildOvertureLinksUnlocked } from "../../src/jobs/overture/rebuild-links.js";

const OPTIONS = {
  region: "europe/germany/berlin",
  dataDir: "/data",
  release: "2026-07-22.0",
};

const stateRow = {
  release: OPTIONS.release,
  region: OPTIONS.region,
  status: "pending",
  attempt_count: 0,
  extracted_count: null,
  candidate_count: null,
  linked_count: null,
  last_error: null,
  started_at: null,
  completed_at: null,
  updated_at: new Date("2026-07-28T00:00:00Z"),
};

function dependencies() {
  return {
    fileExists: vi.fn(() => true),
    extract: vi.fn(async () => ({ extracted: 10 })),
    conflate: vi.fn(async () => ({ linked: 7, candidates: 9, processed: 10 })),
  };
}

beforeEach(() => {
  mocks.unsafe.mockReset();
  mocks.unsafe.mockImplementation(async (query: string) => {
    if (query.includes("SELECT release, region, status")) return [stateRow];
    if (query.includes("RETURNING release, region, status")) {
      return [{ ...stateRow, status: "running", attempt_count: 1 }];
    }
    return [];
  });
});

describe("rebuildOvertureLinks", () => {
  it("claims and completes a rebuild without re-ingesting Places", async () => {
    const deps = dependencies();
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual({ status: "completed", linked: 7, extracted: 10, candidates: 9 });
    expect(deps.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        pbfPath: expect.stringContaining("europe-germany-berlin.osm.pbf"),
      }),
    );
    expect(deps.conflate).toHaveBeenCalledWith(
      expect.objectContaining({ release: OPTIONS.release }),
    );
    expect(mocks.unsafe).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'completed'"),
      expect.arrayContaining([10, 9, 7]),
    );
  });

  it("records a failed attempt and returns a retryable result", async () => {
    const deps = dependencies();
    deps.conflate.mockRejectedValueOnce(new Error("candidate generation failed"));
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual({
      status: "failed",
      linked: 0,
      error: "candidate generation failed",
    });
    expect(mocks.unsafe).toHaveBeenCalledWith(expect.stringContaining("SET status = 'failed'"), [
      "candidate generation failed",
      1,
    ]);
  });

  it("does not run a completed release unless forced", async () => {
    mocks.unsafe.mockResolvedValueOnce([{ ...stateRow, status: "completed", linked_count: "7" }]);
    const deps = dependencies();
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual({ status: "already_completed", linked: 7 });
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.conflate).not.toHaveBeenCalled();
  });

  it("moves a claimed attempt to waiting_for_osm when the PBF is absent", async () => {
    const deps = dependencies();
    deps.fileExists.mockReturnValueOnce(false);
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual(expect.objectContaining({ status: "waiting_for_osm", linked: 0 }));
    expect(deps.extract).not.toHaveBeenCalled();
    expect(mocks.unsafe).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'waiting_for_osm'"),
      expect.arrayContaining([expect.stringContaining("OSM PBF not found"), 1]),
    );
  });
});
