import { describe, expect, it } from "vitest";
import { deriveCoherenceKey, validateCoherentSeries } from "../normalize/coherence";
import { builtInStandardAdapters } from "../standards/builtins";

const ground = {
  basis: "ground" as const,
  providerId: "openaq",
  providerLocationId: "location-1",
  spatialSupportId: "station-1",
};

describe("coherence", () => {
  it("changes for structural location and model dimensions", () => {
    expect(deriveCoherenceKey(ground)).not.toBe(
      deriveCoherenceKey({ ...ground, providerLocationId: "location-2" }),
    );
    const model = {
      basis: "model" as const,
      providerId: "open-meteo",
      modelRunId: "run-1",
      gridCellId: "cell-1",
      verticalLevel: "surface",
      spatialSupportId: "grid-1",
    };
    for (const update of [
      { modelRunId: "run-2" },
      { gridCellId: "cell-2" },
      { verticalLevel: "850hPa" },
      { spatialSupportId: "grid-2" },
    ])
      expect(deriveCoherenceKey({ ...model, ...update })).not.toBe(deriveCoherenceKey(model));
  });

  it("rejects different keys or pollutant windows ending over 60 minutes apart", () => {
    const key = deriveCoherenceKey(ground);
    const makeSeries = (pollutant: "pm25" | "pm10", endAt: string, coherenceKey = key) => ({
      seriesId: pollutant,
      coherenceKey,
      pollutant,
      sensorId: null,
      spatialSupportId: "station-1",
      cadenceMinutes: 60,
      originalUnit: "ug/m3",
      samples: [
        {
          startAt: "2026-08-30T00:00:00Z",
          endAt,
          value: 1,
          unit: "ug/m3" as const,
          valid: true,
          estimated: false,
          gapFilled: false,
        },
      ],
    });
    expect(
      validateCoherentSeries([
        makeSeries("pm25", "2026-08-30T01:00:00Z"),
        makeSeries("pm10", "2026-08-30T02:00:00Z"),
      ]).coherent,
    ).toBe(true);
    expect(
      validateCoherentSeries([
        makeSeries("pm25", "2026-08-30T01:00:00Z"),
        makeSeries("pm10", "2026-08-30T02:01:00Z"),
      ]).coherent,
    ).toBe(false);
    expect(
      validateCoherentSeries([
        makeSeries("pm25", "2026-08-30T01:00:00Z"),
        makeSeries("pm10", "2026-08-30T01:00:00Z", "other"),
      ]).coherent,
    ).toBe(false);
    expect(
      validateCoherentSeries([
        { ...makeSeries("pm25", "2026-08-30T01:00:00Z"), cadenceMinutes: 15 },
        { ...makeSeries("pm10", "2026-08-30T01:30:00Z"), cadenceMinutes: 15 },
      ]).coherent,
    ).toBe(false);
  });

  it("compares the latest end of each series rather than its full history", () => {
    const key = deriveCoherenceKey(ground);
    const series = ["pm25", "pm10"].map((pollutant) => ({
      seriesId: pollutant,
      coherenceKey: key,
      pollutant: pollutant as "pm25",
      sensorId: null,
      spatialSupportId: "station-1",
      cadenceMinutes: 60,
      originalUnit: "ug/m3",
      samples: Array.from({ length: 24 }, (_, offset) => ({
        startAt: new Date(
          Date.parse("2026-08-30T12:00:00Z") - (offset + 1) * 3_600_000,
        ).toISOString(),
        endAt: new Date(Date.parse("2026-08-30T12:00:00Z") - offset * 3_600_000).toISOString(),
        value: 10,
        unit: "ug/m3" as const,
        valid: true,
        estimated: false,
        gapFilled: false,
      })),
    }));

    expect(validateCoherentSeries(series)).toMatchObject({ coherent: true, endSkewMinutes: 0 });
    expect(
      validateCoherentSeries([{ ...series[0], spatialSupportId: "station-2" }, series[1]]).coherent,
    ).toBe(false);
  });

  it("makes every calculated standard reject incoherent series before aggregation", () => {
    const make = (pollutant: "pm25" | "no2", coherenceKey: string) => ({
      seriesId: pollutant,
      coherenceKey,
      pollutant,
      sensorId: null,
      spatialSupportId: "station-1",
      cadenceMinutes: 60,
      originalUnit: "ug/m3",
      samples: [
        {
          startAt: "2026-08-30T11:00:00Z",
          endAt: "2026-08-30T12:00:00Z",
          value: 10,
          unit: "ug/m3" as const,
          valid: true,
          estimated: false,
          gapFilled: false,
        },
      ],
    });
    const input = {
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current" as const,
      series: [make("pm25", "location-a"), make("no2", "location-b")],
    };

    for (const adapter of builtInStandardAdapters.filter(({ calculate }) => calculate)) {
      expect(adapter.calculate?.(input), adapter.standardId).toMatchObject({
        ok: false,
        reason: "incoherent_series",
      });
      expect(adapter.summarizeCompleteness(input), adapter.standardId).toMatchObject({
        passes: false,
        missingRequirements: [
          "Pollutant series must share one spatial and temporal coherence identity",
        ],
      });
    }
  });
});
