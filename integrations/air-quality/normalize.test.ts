import type { ProviderEvidence } from "@openmapx/air-quality";
import { indexId, observationId } from "@openmapx/air-quality/ids";
import { describe, expect, it } from "vitest";

import { normalizeProviderEvidence, ProviderNormalizationError } from "./normalize.js";

const evaluatedAt = "2026-08-30T12:00:00.000Z";
const obsId = observationId({
  sourceId: "fixture",
  originRecordId: "record-1",
  spatialSupportId: "station-1",
  modelRunId: null,
  evaluatedAt,
});

function providerEvidence(update: Partial<ProviderEvidence> = {}): ProviderEvidence {
  return {
    observationId: obsId,
    providerId: "fixture-provider",
    sourceIds: ["fixture"],
    dataAuthority: "aggregator",
    qualityStatus: "preliminary",
    basis: "ground",
    originRecords: [{ sourceId: "fixture", recordId: "record-1" }],
    modelRunId: null,
    verticalLevel: null,
    series: [
      {
        seriesId: "series-1",
        coherenceKey: "station-1",
        pollutant: "pm25",
        sensorId: "sensor-1",
        spatialSupportId: "station-1",
        cadenceMinutes: 60,
        originalUnit: "µg/m³",
        samples: Array.from({ length: 12 }, (_, index) => {
          const end = Date.parse(evaluatedAt) - index * 3_600_000;
          return {
            startAt: new Date(end - 3_600_000).toISOString(),
            endAt: new Date(end).toISOString(),
            value: 12,
            unit: "ug/m3" as const,
            valid: true,
            estimated: false,
            gapFilled: false,
          };
        }),
      },
    ],
    publishedIndices: [],
    observedAt: evaluatedAt,
    forecastFor: null,
    publishedAt: null,
    validUntil: "2026-08-30T13:00:00.000Z",
    spatial: {
      kind: "station",
      id: "station-1",
      name: "Station",
      coordinates: [13.405, 52.52],
      timeZone: "Europe/Berlin",
      distanceMeters: 1_000,
      stationClass: "reference",
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "nearest-station",
    },
    sources: [
      {
        sourceId: "fixture",
        name: "Fixture source",
        url: "https://example.test/data",
        owner: "Fixture owner",
        license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
        methodologyUrl: "https://example.test/method",
        attribution: "Fixture owner",
      },
    ],
    ...update,
  };
}

describe("provider evidence normalization", () => {
  it("computes a complete local index without losing source provenance", () => {
    const result = normalizeProviderEvidence(providerEvidence(), {
      targetAt: evaluatedAt,
      mode: "current",
      localStandardId: "us-epa-2024",
      comparisonStandardId: null,
    });
    expect(result.evidence).toMatchObject({
      observationId: obsId,
      freshness: "fresh",
      pollutants: [{ pollutant: "pm25", value: 12, originalUnit: "µg/m³" }],
      sources: [{ sourceId: "fixture", owner: "Fixture owner" }],
      completenessByStandard: { "us-epa-2024": { passes: true } },
    });
    expect(result.evidence.indices[0]).toMatchObject({
      standardId: "us-epa-2024",
      authority: "openmapx",
      derivation: "openmapx-computed-index",
    });
  });

  it("retains provider-native indices as unverified methods with no official standard id", () => {
    const native = providerEvidence({
      basis: "model",
      publishedIndices: [
        {
          indexId: indexId({
            observationId: obsId,
            methodId: "open-meteo-us-aqi",
            methodRevision: "v1",
            standardId: null,
            standardRevision: null,
          }),
          methodId: "open-meteo-us-aqi",
          methodRevision: "v1",
          claimedStandardId: null,
          value: 42,
          displayValue: "42",
          categoryId: "provider-native-42",
          dominantPollutants: [],
        },
      ],
    });
    const result = normalizeProviderEvidence(native, {
      targetAt: evaluatedAt,
      mode: "current",
      localStandardId: "eu-eea-current",
      comparisonStandardId: null,
    });
    expect(result.evidence.indices).toContainEqual(
      expect.objectContaining({
        standardId: null,
        standardRevision: null,
        methodId: "open-meteo-us-aqi",
        basis: "model",
      }),
    );
  });

  it("rejects malformed provider provenance before it reaches selection", () => {
    expect(() =>
      normalizeProviderEvidence(providerEvidence({ sources: [] }), {
        targetAt: evaluatedAt,
        mode: "current",
        localStandardId: "us-epa-2024",
        comparisonStandardId: null,
      }),
    ).toThrow(ProviderNormalizationError);
  });

  it("accepts a validated community-published index without inventing pollutant series", () => {
    const community = providerEvidence({
      series: [],
      spatial: {
        kind: "community",
        id: "eccc-community-1",
        name: "Ottawa",
        coordinates: [-75.6972, 45.4215],
        timeZone: "America/Toronto",
        distanceMeters: null,
        stationClass: null,
        mobile: null,
        coversRequestedPoint: true,
        coverageMethod: "point-in-polygon",
      },
      publishedAt: "2026-08-30T11:00:00.000Z",
      publishedIndices: [
        {
          indexId: indexId({
            observationId: obsId,
            methodId: "eccc-aqhi",
            methodRevision: "2026-08-30",
            standardId: "ca-aqhi-current",
            standardRevision: "eccc-aqhi-2026-08-29",
          }),
          methodId: "eccc-aqhi",
          methodRevision: "2026-08-30",
          claimedStandardId: "ca-aqhi-current",
          value: 3,
          displayValue: "3",
          categoryId: "low-risk",
          dominantPollutants: [],
        },
      ],
    });
    const result = normalizeProviderEvidence(community, {
      targetAt: evaluatedAt,
      mode: "current",
      localStandardId: "ca-aqhi-current",
      comparisonStandardId: null,
      subdivisionCode: "CA-ON",
    });
    expect(result.evidence.pollutants).toEqual([]);
    expect(result.evidence.indices).toContainEqual(
      expect.objectContaining({
        standardId: "ca-aqhi-current",
        authority: "official-agency",
        derivation: "published-index",
      }),
    );
  });
});
