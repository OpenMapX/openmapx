import type { ProviderEvidence } from "@openmapx/air-quality";
import { describe, expect, it } from "vitest";
import { projectLegacyStations } from "./compatibility.js";

function evidence(): ProviderEvidence {
  return {
    observationId: "obs_1_fixture",
    providerId: "openaq",
    sourceIds: ["openaq"],
    dataAuthority: "aggregator",
    qualityStatus: "preliminary",
    basis: "ground",
    originRecords: [
      { sourceId: "openaq", recordId: "location:2178:sensor:3920:2026-08-30T11:00:00Z" },
    ],
    modelRunId: null,
    verticalLevel: null,
    series: [
      {
        seriesId: "openaq:2178:3920",
        coherenceKey: "location-2178",
        pollutant: "pm25",
        sensorId: "3920",
        spatialSupportId: "openaq-location-2178",
        cadenceMinutes: 60,
        originalUnit: "µg/m³",
        samples: [
          {
            startAt: "2026-08-30T10:00:00Z",
            endAt: "2026-08-30T11:00:00Z",
            value: 9.75,
            unit: "ug/m3",
            valid: true,
            estimated: false,
            gapFilled: false,
          },
        ],
      },
    ],
    publishedIndices: [],
    observedAt: "2026-08-30T11:00:00Z",
    forecastFor: null,
    publishedAt: null,
    validUntil: null,
    spatial: {
      kind: "station",
      id: "openaq-location-2178",
      name: "Del Norte",
      coordinates: [-106.584702, 35.1353],
      timeZone: "America/Denver",
      distanceMeters: 820,
      stationClass: "reference",
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "nearest-station",
    },
    sources: [
      {
        sourceId: "openaq",
        name: "OpenAQ via AirNow",
        url: "https://openaq.org/",
        owner: "Unknown Governmental Organization",
        license: { name: "US Public Domain", url: null },
        methodologyUrl: "https://docs.openaq.org/resources/measurements",
        attribution: "Unknown Governmental Organization",
      },
    ],
  };
}

describe("OpenAQ legacy projection", () => {
  it("preserves the exact legacy fields and never invents AQI from instantaneous PM2.5", () => {
    expect(projectLegacyStations([evidence()])).toEqual([
      {
        id: 2178,
        name: "Del Norte",
        lat: 35.1353,
        lng: -106.584702,
        aqi: null,
        pm25: 9.75,
        lastUpdated: "2026-08-30T11:00:00Z",
        attribution: { name: "Unknown Governmental Organization", url: "https://openaq.org/" },
        license: "US Public Domain",
      },
    ]);
    expect(Object.keys(projectLegacyStations([evidence()])[0]).sort()).toEqual(
      ["aqi", "attribution", "id", "lastUpdated", "lat", "license", "lng", "name", "pm25"].sort(),
    );
  });

  it("omits evidence without a valid PM2.5 measurement", () => {
    const missing = evidence();
    missing.series[0].samples[0].valid = false;
    expect(projectLegacyStations([missing])).toEqual([]);
  });
});
