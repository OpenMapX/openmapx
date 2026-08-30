import type { AirQualityEvidence } from "@openmapx/air-quality";
import { indexId, observationId } from "@openmapx/air-quality/ids";
import { describe, expect, it } from "vitest";

import { hasEcccCommunityMatch } from "./current.js";

const observedAt = "2026-08-30T12:00:00.000Z";
const obsId = observationId({
  sourceId: "eccc-aqhi-geomet",
  originRecordId: "AQ_OBS-FCWYG-20260830120000",
  spatialSupportId: "ECCC-FCWYG",
  modelRunId: null,
  evaluatedAt: observedAt,
});
const idxId = indexId({
  observationId: obsId,
  methodId: "eccc-aqhi",
  methodRevision: "2026-08-30",
  standardId: "ca-aqhi-current",
  standardRevision: "eccc-aqhi-2026-08-29",
});

function officialCommunity(): AirQualityEvidence {
  return {
    observationId: obsId,
    providerId: "eccc-aqhi",
    sourceIds: ["eccc-aqhi-geomet"],
    dataAuthority: "official-agency",
    qualityStatus: "quality-assured",
    basis: "ground",
    indices: [
      {
        indexId: idxId,
        standardId: "ca-aqhi-current",
        standardRevision: "eccc-aqhi-2026-08-29",
        methodId: "eccc-aqhi",
        methodRevision: "2026-08-30",
        effectiveDate: "2026-05-28",
        value: 3,
        displayValue: "3",
        categoryId: "low-risk",
        dominantPollutants: [],
        authority: "official-agency",
        qualityStatus: "quality-assured",
        basis: "ground",
        derivation: "published-index",
        inputObservationIds: [obsId],
      },
    ],
    pollutants: [],
    observedAt,
    forecastFor: null,
    publishedAt: "2026-08-30T11:00:00.000Z",
    validUntil: "2026-08-30T13:00:00.000Z",
    freshness: "fresh",
    spatial: {
      kind: "community",
      id: "ECCC-FCWYG",
      name: "Toronto Downtown",
      coordinates: [-79.3969444, 43.6758333],
      timeZone: "America/Toronto",
      distanceMeters: null,
      stationClass: null,
      mobile: null,
      coversRequestedPoint: true,
      coverageMethod: "point-in-polygon",
    },
    completenessByStandard: {
      "ca-aqhi-current": { passes: true, missingRequirements: [] },
    },
    sources: [
      {
        sourceId: "eccc-aqhi-geomet",
        name: "ECCC AQHI",
        url: "https://api.weather.gc.ca/collections/aqhi-observations-realtime",
        owner: "Environment and Climate Change Canada",
        license: {
          name: "Open Government Licence – Canada",
          url: "https://open.canada.ca/en/open-government-licence-canada",
        },
        methodologyUrl: "https://eccc-msc.github.io/open-data/msc-data/aqhi/readme_aqhi_en/",
        attribution: "Environment and Climate Change Canada",
      },
    ],
    warnings: [],
  };
}

describe("ECCC jurisdiction evidence", () => {
  it("accepts only validated official ECCC community coverage with a verified AQHI method", () => {
    const valid = officialCommunity();
    expect(hasEcccCommunityMatch([valid])).toBe(true);

    expect(
      hasEcccCommunityMatch([
        {
          ...valid,
          spatial: {
            ...valid.spatial,
            coversRequestedPoint: false,
            coverageMethod: "nearest-community",
          },
        },
      ]),
    ).toBe(false);
    expect(
      hasEcccCommunityMatch([
        {
          ...valid,
          indices: [
            {
              ...valid.indices[0],
              standardId: null,
              standardRevision: null,
              methodId: "eccc-geomet-aqhi-observation-method-unspecified",
            },
          ],
        },
      ]),
    ).toBe(false);
    expect(hasEcccCommunityMatch([{ ...valid, providerId: "environment-canada-lookalike" }])).toBe(
      false,
    );
    expect(hasEcccCommunityMatch([{ ...valid, freshness: "stale" }])).toBe(false);
  });
});
