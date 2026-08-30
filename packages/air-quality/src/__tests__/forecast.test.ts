import { describe, expect, it } from "vitest";

import { groupForecastEvidence } from "../forecast";
import type { AirQualitySelectionResult } from "../selection";
import type { AirQualityEvidence } from "../types";

const emptySelection: AirQualitySelectionResult = {
  primaryEvidenceId: null,
  primaryIndexId: null,
  rankedIndexIds: [],
  rankedRawEvidenceIds: [],
  secondaryEvidenceIds: [],
  reasons: [],
  rejected: [],
  warnings: [],
};

function forecast(
  id: string,
  providerId: string,
  forecastFor: string,
  validUntil: string,
): AirQualityEvidence {
  return {
    observationId: id,
    providerId,
    sourceIds: [providerId],
    dataAuthority: "official-agency",
    qualityStatus: "preliminary",
    basis: providerId === "model" ? "model" : "ground",
    indices: [],
    pollutants: [],
    observedAt: null,
    forecastFor,
    publishedAt: "2026-08-30T09:00:00Z",
    validUntil,
    freshness: "fresh",
    spatial: {
      kind: providerId === "model" ? "grid-cell" : "reporting-area",
      id: providerId,
      name: providerId,
      coordinates: null,
      timeZone: "UTC",
      distanceMeters: null,
      stationClass: null,
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "provider-point-lookup",
    },
    completenessByStandard: {},
    sources: [],
    warnings: [],
  };
}

describe("forecast grouping", () => {
  it("creates only window/validity frames and never interpolates a daily official value", () => {
    const daily = forecast("daily", "official", "2026-08-30T10:00:00Z", "2026-08-31T10:00:00Z");
    const hourly1 = forecast("hour-1", "model", "2026-08-30T10:00:00Z", "2026-08-30T11:00:00Z");
    const hourly2 = forecast("hour-2", "model", "2026-08-30T11:00:00Z", "2026-08-30T12:00:00Z");
    const result = groupForecastEvidence({
      windowStart: "2026-08-30T10:00:00Z",
      windowEnd: "2026-08-30T13:00:00Z",
      evidence: [hourly2, daily, hourly1, daily],
      selectFrame: () => ({ ...emptySelection }),
    });
    expect(result.frames.map(({ frameAt }) => frameAt)).toEqual([
      "2026-08-30T10:00:00.000Z",
      "2026-08-30T11:00:00.000Z",
    ]);
    expect(result.frames.map(({ evidenceIds }) => evidenceIds)).toEqual([
      ["daily", "hour-1"],
      ["daily", "hour-2"],
    ]);
    expect(result.evidence).toHaveLength(3);
    expect(result.series).toHaveLength(2);
  });

  it("is permutation invariant and fails conflicting duplicate IDs", () => {
    const a = forecast("a", "official", "2026-08-30T10:00:00Z", "2026-08-31T10:00:00Z");
    const b = forecast("b", "model", "2026-08-30T11:00:00Z", "2026-08-30T12:00:00Z");
    const make = (evidence: AirQualityEvidence[]) =>
      groupForecastEvidence({
        windowStart: "2026-08-30T10:00:00Z",
        windowEnd: "2026-08-30T13:00:00Z",
        evidence,
        selectFrame: () => ({ ...emptySelection }),
      });
    expect(JSON.stringify(make([b, a]))).toBe(JSON.stringify(make([a, b])));
    expect(() => make([a, { ...a, providerId: "changed" }])).toThrow(/Conflicting duplicate/);
  });

  it("orders series evidence by validity time before its stable ID", () => {
    const earlier = forecast("z-earlier", "model", "2026-08-30T10:00:00Z", "2026-08-30T11:00:00Z");
    const later = forecast("a-later", "model", "2026-08-30T11:00:00Z", "2026-08-30T12:00:00Z");
    const result = groupForecastEvidence({
      windowStart: "2026-08-30T10:00:00Z",
      windowEnd: "2026-08-30T13:00:00Z",
      evidence: [later, earlier],
      selectFrame: () => ({ ...emptySelection }),
    });

    expect(result.series[0]?.evidenceIds).toEqual(["z-earlier", "a-later"]);
    expect(result.series[0]?.seriesId).not.toContain("\0");
  });
});
