import { describe, expect, it } from "vitest";
import type { OpenAQLocation } from "./schemas.js";
import { rankStationDemand } from "./station-demand.js";

function location(id: number, input: Partial<OpenAQLocation> = {}): OpenAQLocation {
  return {
    id,
    name: `Station ${id}`,
    locality: null,
    timezone: "UTC",
    country: { id: 1, code: "US", name: "United States" },
    owner: { id: 1, name: "Owner" },
    provider: { id: 1, name: "Provider" },
    isMobile: false,
    isMonitor: false,
    instruments: [],
    sensors: [],
    coordinates: { latitude: 40 + id / 1000, longitude: -74 },
    licenses: [],
    bounds: [-74, 40, -74, 40],
    distance: null,
    datetimeFirst: null,
    datetimeLast: { utc: "2026-08-30T10:00:00Z", local: "2026-08-30T10:00:00Z" },
    ...input,
  };
}

describe("deterministic OpenAQ station demand", () => {
  it("ranks recognized monitors, freshness, coverage cells, then stable id", () => {
    const result = rankStationDemand(
      [
        location(8, {
          datetimeLast: { utc: "2026-08-30T09:00:00Z", local: "2026-08-30T09:00:00Z" },
        }),
        location(7, { isMonitor: true }),
        location(6, {
          datetimeLast: { utc: "2026-08-30T11:00:00Z", local: "2026-08-30T11:00:00Z" },
        }),
      ],
      { zoom: 8, limit: 2 },
    );
    expect(result.selected.map((item) => item.id)).toEqual([7, 6]);
    expect(result.diagnostics).toEqual({ candidateCount: 3, servedCount: 2, skippedCount: 1 });
  });

  it("is stable under input reordering and uses screen cells to spread coverage", () => {
    const candidates = [
      location(3),
      location(1),
      location(2, { coordinates: { latitude: -20, longitude: 120 } }),
    ];
    const forward = rankStationDemand(candidates, { zoom: 4, limit: 2 });
    const reverse = rankStationDemand([...candidates].reverse(), { zoom: 4, limit: 2 });
    expect(forward.selected.map((item) => item.id)).toEqual(
      reverse.selected.map((item) => item.id),
    );
    expect(forward.selected.some((item) => item.id === 2)).toBe(true);
  });
});
