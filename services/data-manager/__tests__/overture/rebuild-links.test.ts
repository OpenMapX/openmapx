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

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    release: OPTIONS.release,
    region: OPTIONS.region,
    place_count: "100",
    status: "pending",
    phase: "extract",
    attempt_count: 0,
    source_fingerprint: null,
    emitted_count: null,
    extracted_count: null,
    processed_count: null,
    candidate_count: null,
    component_count: null,
    assignment_cursor: null,
    staged_link_count: null,
    linked_count: null,
    score_cursor_h3: null,
    score_cursor_type: null,
    score_cursor_id: null,
    phase_durations_ms: {},
    last_error: null,
    started_at: null,
    attempt_started_at: null,
    phase_started_at: null,
    completed_at: null,
    updated_at: new Date("2026-07-28T00:00:00Z"),
    ...overrides,
  };
}

let state: Record<string, unknown> = makeState();

function dependencies() {
  return {
    fileExists: vi.fn(() => true),
    fingerprint: vi.fn(() => "1234:5678"),
    extract: vi.fn(async () => ({ emitted: 12, extracted: 10 })),
    score: vi.fn(async () => ({
      candidates: 9,
      processed: 10,
      cursor: { h3: "881f1d4887fffff", osmType: "way", osmId: "99" },
    })),
    assign: vi.fn(async () => ({ components: 8, assignmentCursor: 8, stagedLinks: 7 })),
    validateFusedQuality: vi.fn(async () => ({ applicableCases: 1, cases: [] })),
    publish: vi.fn(async () => ({ linked: 7 })),
    cleanup: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  state = makeState();
  mocks.unsafe.mockReset();
  mocks.unsafe.mockImplementation(async (query: string, params: unknown[] = []) => {
    if (query.includes("RETURNING release, region, place_count")) {
      state = {
        ...state,
        status: "running",
        attempt_count: Number(state.attempt_count) + 1,
        phase_started_at: new Date(),
        updated_at: new Date(),
      };
      return [state];
    }
    if (query.includes("SELECT release, region, place_count")) return [state];
    if (query.includes("phase = 'score', phase_started_at")) {
      state = {
        ...state,
        phase: "score",
        source_fingerprint: params[0],
        emitted_count: String(params[1]),
        extracted_count: String(params[2]),
        processed_count: "0",
        candidate_count: "0",
      };
    } else if (query.includes("phase = 'assign', phase_started_at")) {
      state = {
        ...state,
        phase: "assign",
        processed_count: String(params[0]),
        candidate_count: String(params[1]),
        score_cursor_h3: params[2],
        score_cursor_type: params[3],
        score_cursor_id: String(params[4]),
      };
    } else if (query.includes("phase = 'publish', phase_started_at")) {
      state = {
        ...state,
        phase: "publish",
        component_count: String(params[0]),
        assignment_cursor: String(params[1]),
        staged_link_count: String(params[2]),
      };
    } else if (query.includes("phase = 'complete', status = 'completed'")) {
      state = {
        ...state,
        phase: "complete",
        status: "completed",
        linked_count: String(params[0]),
        staged_link_count: String(params[0]),
      };
    } else if (query.includes("SET") && query.includes("status = 'failed'")) {
      state = { ...state, status: "failed", last_error: params[0] };
    } else if (query.includes("status = 'waiting_for_osm'")) {
      state = { ...state, status: "waiting_for_osm", last_error: params[0] };
    }
    return [];
  });
});

describe("rebuildOvertureLinks", () => {
  it("completes all durable phases without re-ingesting Places", async () => {
    const deps = dependencies();
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual({
      status: "completed",
      linked: 7,
      emitted: 12,
      extracted: 10,
      candidates: 9,
      components: 8,
      phaseDurationsMs: {},
    });
    expect(deps.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        pbfPath: expect.stringContaining("europe-germany-berlin.osm.pbf"),
      }),
    );
    expect(deps.score).toHaveBeenCalledWith(
      expect.objectContaining({ release: OPTIONS.release, resume: undefined }),
    );
    expect(deps.assign).toHaveBeenCalled();
    expect(deps.validateFusedQuality).toHaveBeenCalled();
    expect(deps.publish).toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalled();
  });

  it("resumes scoring from its durable keyset cursor without extracting again", async () => {
    state = makeState({
      status: "failed",
      phase: "score",
      source_fingerprint: "1234:5678",
      emitted_count: "12",
      extracted_count: "10",
      processed_count: "4",
      candidate_count: "3",
      score_cursor_h3: "881f1d4887fffff",
      score_cursor_type: "node",
      score_cursor_id: "42",
    });
    const deps = dependencies();
    await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.score).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: {
          cursor: { h3: "881f1d4887fffff", osmType: "node", osmId: "42" },
          processed: 4,
          candidates: 3,
        },
      }),
    );
  });

  it("records the failed phase and leaves earlier work retryable", async () => {
    const deps = dependencies();
    deps.score.mockRejectedValueOnce(new Error("candidate generation failed"));
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual({
      status: "failed",
      linked: 0,
      phase: "score",
      error: "candidate generation failed",
    });
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("does not run a completed release unless explicitly restarted", async () => {
    state = makeState({ status: "completed", phase: "complete", linked_count: "7" });
    const deps = dependencies();
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual({ status: "already_completed", linked: 7 });
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("moves a claimed attempt to waiting_for_osm when the PBF is absent", async () => {
    const deps = dependencies();
    deps.fileExists.mockReturnValueOnce(false);
    const result = await rebuildOvertureLinksUnlocked(OPTIONS, deps as never);
    expect(result).toEqual(expect.objectContaining({ status: "waiting_for_osm", linked: 0 }));
    expect(deps.extract).not.toHaveBeenCalled();
  });
});
