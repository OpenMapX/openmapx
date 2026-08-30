import { describe, expect, it } from "vitest";

import { indexId, observationId } from "../ids";

const observation = {
  sourceId: "airnow",
  originRecordId: "station-1:2026-08-30T10:00:00Z",
  spatialSupportId: "station-1",
  modelRunId: null,
  evaluatedAt: "2026-08-30T10:00:00.000Z",
};

describe("air-quality identities", () => {
  it("is deterministic and excludes user coordinates and standards by construction", () => {
    const id = observationId(observation);
    expect(observationId({ ...observation })).toBe(id);
    expect(id).toMatch(/^obs_1_[A-Za-z0-9_-]{43}$/);
    expect(id).not.toContain("station-1");
    expect(Object.keys(observation)).not.toContain("coordinates");
    expect(Object.keys(observation)).not.toContain("standardId");
    expect(observationId({ ...observation, evaluatedAt: "2026-08-30T10:00:00Z" })).toBe(id);
    expect(() => observationId({ ...observation, evaluatedAt: "not-a-time" })).toThrow(
      /evaluatedAt/,
    );
  });

  it("changes when any underlying observation identity field changes", () => {
    for (const [key, value] of [
      ["sourceId", "openaq"],
      ["originRecordId", "record-2"],
      ["spatialSupportId", "station-2"],
      ["modelRunId", "run-1"],
      ["evaluatedAt", "2026-08-30T11:00:00.000Z"],
    ] as const) {
      expect(observationId({ ...observation, [key]: value })).not.toBe(observationId(observation));
    }
  });

  it("adds method and standard revision to index identity", () => {
    const base = {
      observationId: observationId(observation),
      methodId: "epa-aqi",
      methodRevision: "2024-05",
      standardId: "us-epa-2024",
      standardRevision: "epa-aqi-tad-2024-05",
    };
    const id = indexId(base);
    expect(id).toMatch(/^idx_1_[A-Za-z0-9_-]{43}$/);
    expect(indexId({ ...base, methodRevision: "2025-01" })).not.toBe(id);
    expect(indexId({ ...base, standardRevision: "epa-aqi-tad-2025-01" })).not.toBe(id);
    expect(indexId({ ...base, standardId: null, standardRevision: null })).not.toBe(id);
  });

  it("cannot collide through delimiter injection", () => {
    expect(
      observationId({
        ...observation,
        sourceId: "a|b",
        originRecordId: "c",
      }),
    ).not.toBe(
      observationId({
        ...observation,
        sourceId: "a",
        originRecordId: "b|c",
      }),
    );
  });
});
