import { describe, expect, it } from "vitest";

import {
  airQualityApiErrorSchema,
  airQualityCurrentResponseSchema,
  airQualityForecastResponseSchema,
  airQualityStationsResponseSchema,
} from "../api";

const jurisdiction = {
  countryCode: "US",
  subdivisionCode: null,
  programId: "us-epa-aqi",
  resolution: "boundary-artifact",
  resolverId: "natural-earth-air-quality",
  resolverRevision: "test",
  requestHintMatched: null,
  localStandardId: "us-epa-2024",
} as const;

const meta = {
  generatedAt: "2026-08-30T12:00:00.000Z",
  cache: "miss",
  providersCandidate: ["openaq"],
  providersServed: [],
  providersFailed: [],
  providersPolicyExcluded: [],
  truncated: false,
  warnings: [],
} as const;

const current = {
  status: "unavailable",
  jurisdiction,
  primaryEvidenceId: null,
  primaryIndexId: null,
  comparisonStandardId: null,
  comparisonIndexIds: [],
  evidence: [],
  selection: { reasons: [], rejected: [] },
  meta,
} as const;

describe("canonical air-quality API schemas", () => {
  it("accepts the exact empty current envelope and rejects unknown closed codes", () => {
    expect(airQualityCurrentResponseSchema.parse(current)).toEqual(current);
    expect(() =>
      airQualityCurrentResponseSchema.parse({ ...current, status: "degraded" }),
    ).toThrow();
    expect(() =>
      airQualityCurrentResponseSchema.parse({
        ...current,
        meta: { ...meta, warnings: ["future_warning"] },
      }),
    ).toThrow();
  });

  it("rejects rather than silently stripping unknown provenance fields", () => {
    expect(() =>
      airQualityCurrentResponseSchema.parse({ ...current, upstreamPayload: {} }),
    ).toThrow();
  });

  it("enforces current and forecast evidence bounds", () => {
    const oversizedCurrent = { ...current, evidence: Array.from({ length: 33 }, () => ({})) };
    expect(() => airQualityCurrentResponseSchema.parse(oversizedCurrent)).toThrow();

    const forecast = {
      status: "unavailable",
      jurisdiction,
      window: {
        startAt: "2026-08-30T12:00:00.000Z",
        endAt: "2026-08-31T12:00:00.000Z",
        requestedHours: 24,
      },
      comparisonStandardId: null,
      evidence: Array.from({ length: 1_025 }, () => ({})),
      series: [],
      frames: [],
      meta,
    };
    expect(() => airQualityForecastResponseSchema.parse(forecast)).toThrow();
  });

  it("enforces 500 station features and opaque station IDs", () => {
    const feature = {
      type: "Feature",
      id: "stn_1_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
      geometry: { type: "Point", coordinates: [-106.58, 35.13] },
      properties: {
        stationId: "stn_1_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
        name: "Station",
        pollutant: "pm25",
        value: 9.75,
        unit: "ug/m3",
        intervalStart: "2026-08-30T10:00:00.000Z",
        intervalEnd: "2026-08-30T11:00:00.000Z",
        freshness: "fresh",
        observedAt: "2026-08-30T11:00:00.000Z",
        stationClass: "reference",
        mobile: false,
        owner: "Owner",
        providerId: "openaq",
        sourceIds: ["openaq"],
        localIndex: null,
      },
    } as const;
    const response = {
      type: "FeatureCollection",
      features: [feature],
      nextCursor: null,
      meta: {
        ...meta,
        candidateCount: 1,
        servedCount: 1,
        skippedCount: 0,
      },
    };
    expect(airQualityStationsResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      airQualityStationsResponseSchema.parse({
        ...response,
        features: Array.from({ length: 501 }, () => feature),
      }),
    ).toThrow();
    expect(() =>
      airQualityStationsResponseSchema.parse({
        ...response,
        features: [{ ...feature, id: "upstream-station-id" }],
      }),
    ).toThrow();
  });

  it("keeps the non-2xx error object exact and its codes closed", () => {
    const error = { code: "INVALID_QUERY", message: "Invalid query", details: { field: "lat" } };
    expect(airQualityApiErrorSchema.parse(error)).toEqual(error);
    expect(() => airQualityApiErrorSchema.parse({ ...error, code: "NO_DATA" })).toThrow();
    expect(() => airQualityApiErrorSchema.parse({ ...error, stack: "secret" })).toThrow();
  });
});
