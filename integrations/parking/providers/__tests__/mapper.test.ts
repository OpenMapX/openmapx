import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapParkingToDetail, mapParkingToResult } from "../mapper.js";

function makeFacility(overrides: Partial<ParkingFacility> = {}): ParkingFacility {
  return {
    coordinates: [9.1, 48.7],
    hasRealtimeData: true,
    id: "parkapi-v3:1",
    name: "Test Parking",
    parkingType: "garage",
    sources: ["parkapi-v3"],
    ...overrides,
  };
}

describe("parking mapper", () => {
  it("keeps stale realtime availability out of the available result variant", () => {
    const result = mapParkingToResult(
      makeFacility({
        capacity: 100,
        freeSpaces: 40,
        isStale: true,
        realtimeDataUpdatedAt: "2026-05-06T11:00:00.000Z",
      }),
    );

    expect(result.variant).toBe("unknown");
    expect(result.summary).toBe("Availability stale");
  });

  it("adds freshness, source, license, and quality sections to details", () => {
    const detail = mapParkingToDetail(
      makeFacility({
        capacity: 100,
        dataUpdatedAt: "2026-05-06T11:00:00.000Z",
        freeSpaces: 40,
        isStale: true,
        qualityWarnings: ["Realtime availability is older than 30 minutes."],
        realtimeDataUpdatedAt: "2026-05-06T11:00:00.000Z",
        sourceAttribution: {
          contributor: "MobiData BW",
          license: "dl-de/by-2-0",
        },
        sourceUid: "bw",
      }),
    );

    expect(detail.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rows: expect.arrayContaining([
            ["Data Freshness", "Stale"],
            ["Last Updated", "2026-05-06 11:00:00 UTC"],
          ]),
          title: "Availability",
        }),
        expect.objectContaining({
          items: ["Realtime availability is older than 30 minutes."],
          title: "Data Quality",
        }),
        expect.objectContaining({
          collapsed: true,
          rows: expect.arrayContaining([
            ["Source", "MobiData BW"],
            ["Source ID", "bw"],
            ["License", "dl-de/by-2-0"],
            ["Last Updated", "2026-05-06 11:00:00 UTC"],
          ]),
          title: "Source",
        }),
      ]),
    );
  });
});
