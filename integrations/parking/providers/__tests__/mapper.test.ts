import { isI18nToken } from "@openmapx/integration-framework/strings";
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
    expect(result.summary).toEqual({ $t: "summary.stale" });
  });

  it("adds freshness, source, and quality sections to details", () => {
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
            [{ $t: "row.dataFreshness" }, { $t: "shared.value.stale" }],
            [{ $t: "shared.row.lastUpdated" }, "2026-05-06 11:00:00 UTC"],
          ]),
          title: { $t: "section.availability" },
        }),
        expect.objectContaining({
          items: [{ $t: "quality.realtimeStale" }],
          title: { $t: "shared.section.dataQuality" },
        }),
        expect.objectContaining({
          collapsed: true,
          rows: expect.arrayContaining([
            [{ $t: "shared.row.source" }, "MobiData BW"],
            [{ $t: "shared.row.sourceId" }, "bw"],
            [{ $t: "shared.row.lastUpdated" }, "2026-05-06 11:00:00 UTC"],
          ]),
          title: { $t: "shared.section.source" },
        }),
      ]),
    );
  });

  it("surfaces the per-feed license as a clickable attribution with SPDX-derived URL", () => {
    const detail = mapParkingToDetail(
      makeFacility({
        sourceAttribution: {
          contributor: "MobiData BW",
          license: "dl-de/by-2-0",
        },
      }),
    );

    expect(detail.attributions).toEqual([
      {
        text: "MobiData BW",
        url: "",
        license: "DL-DE-BY-2.0",
        licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
      },
    ]);
  });

  it("emits I18nToken for section titles and row labels (no English literals cross the contract)", () => {
    const facility: ParkingFacility = {
      id: "test:1",
      name: "Test",
      coordinates: [0, 0],
      sources: ["test"],
      parkingType: "garage",
      hasRealtimeData: true,
      freeSpaces: 12,
      capacity: 50,
    };
    const detail = mapParkingToDetail(facility);
    for (const section of detail.sections) {
      expect(
        isI18nToken(section.title),
        `section.title should be I18nToken, got: ${JSON.stringify(section.title)}`,
      ).toBe(true);
      if (section.rows) {
        for (const [label] of section.rows) {
          expect(
            isI18nToken(label),
            `row label should be I18nToken, got: ${JSON.stringify(label)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("omits the type row (and an otherwise-empty facility section) when type is unknown", () => {
    const detail = mapParkingToDetail(makeFacility({ parkingType: "unknown" }));
    const facilitySection = detail.sections.find(
      (s) => isI18nToken(s.title) && s.title.$t === "section.facility",
    );
    // The facility had no other structured fields, so the section self-hides
    // rather than rendering a lone "Type: Unknown" row.
    expect(facilitySection).toBeUndefined();
  });

  it("keeps the facility section but drops the type row when type is unknown but other fields exist", () => {
    const detail = mapParkingToDetail(makeFacility({ parkingType: "unknown", capacity: 80 }));
    const facilitySection = detail.sections.find(
      (s) => isI18nToken(s.title) && s.title.$t === "section.facility",
    );
    expect(facilitySection).toBeDefined();
    const labels = (facilitySection?.rows ?? []).map(([label]) =>
      isI18nToken(label) ? label.$t : label,
    );
    expect(labels).not.toContain("shared.row.type");
    expect(labels).toContain("shared.row.capacity");
  });

  it("emits I18nToken for summary on result cards", () => {
    const facility: ParkingFacility = {
      id: "test:1",
      name: "Test",
      coordinates: [0, 0],
      sources: ["test"],
      parkingType: "garage",
      hasRealtimeData: true,
      freeSpaces: 12,
      capacity: 50,
    };
    const result = mapParkingToResult(facility);
    expect(isI18nToken(result.summary)).toBe(true);
  });
});
