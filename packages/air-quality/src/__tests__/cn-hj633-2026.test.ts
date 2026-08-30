import { describe, expect, it } from "vitest";
import fixture from "../__fixtures__/cn-hj633-2026.json";
import { calculateHjSubIndex, cnHj6332026Adapter } from "../standards/cn-hj633-2026";

describe("China HJ 633-2026", () => {
  it("matches all independently transcribed daily and real-time boundaries", () => {
    for (const [pollutant, concentration, expected] of fixture.dailyBoundaryCases)
      expect(calculateHjSubIndex(pollutant as "pm25", concentration as number, "daily")).toBe(
        expected,
      );
    for (const [pollutant, concentration, expected] of fixture.realtimeBoundaryCases)
      expect(calculateHjSubIndex(pollutant as "pm25", concentration as number, "realtime")).toBe(
        expected,
      );
  });

  it("truncates concentration to mandated precision and rounds IAQI upward", () => {
    expect(calculateHjSubIndex("pm25", 35.99, "realtime")).toBe(50);
    expect(calculateHjSubIndex("pm25", 36, "realtime")).toBe(52);
    expect(calculateHjSubIndex("co", 2.09, "daily")).toBe(50);
  });

  it("applies the normative SO2 and O3 caps", () => {
    expect(calculateHjSubIndex("so2", 801, "realtime")).toBe(200);
    expect(calculateHjSubIndex("o3", 801, "daily")).toBe(300);
    expect(calculateHjSubIndex("pm25", 1_000, "realtime")).toBe(500);
  });

  it("rejects evidence before the 2026-03-01 cutover", () => {
    const result = cnHj6332026Adapter.calculate?.({
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: "2026-02-28T15:59:59Z",
      mode: "history",
      series: [],
    });
    expect(result).toEqual({
      ok: false,
      reason: "wrong_standard",
      missingRequirements: ["HJ 633-2026 is effective from 2026-03-01 in China"],
    });
  });

  it("retains tied primary pollutants", () => {
    const sample = (pollutant: "pm10" | "pm25", value: number) => ({
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant,
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes: 60,
      originalUnit: "ug/m3",
      samples: [
        {
          startAt: "2026-03-01T00:00:00Z",
          endAt: "2026-03-01T01:00:00Z",
          value,
          unit: "ug/m3" as const,
          valid: true,
          estimated: false,
          gapFilled: false,
        },
      ],
    });
    expect(
      cnHj6332026Adapter.calculate?.({
        observationId: "obs",
        outputIndexId: "idx",
        evaluatedAt: "2026-03-01T01:00:00Z",
        mode: "current",
        series: [sample("pm10", 120), sample("pm25", 60)],
      }),
    ).toMatchObject({ ok: true, index: { value: 100, dominantPollutants: ["pm10", "pm25"] } });
  });

  it("uses the daily table for a complete 24-hour concentration", () => {
    expect(
      cnHj6332026Adapter.calculate?.({
        observationId: "obs_daily",
        outputIndexId: "idx_daily",
        evaluatedAt: "2026-03-02T00:00:00Z",
        mode: "history",
        series: [
          {
            seriesId: "so2-daily",
            coherenceKey: "one",
            pollutant: "so2",
            sensorId: null,
            spatialSupportId: "station",
            cadenceMinutes: 1_440,
            originalUnit: "ug/m3",
            samples: [
              {
                startAt: "2026-03-01T00:00:00Z",
                endAt: "2026-03-02T00:00:00Z",
                value: 100,
                unit: "ug/m3",
                valid: true,
                estimated: false,
                gapFilled: false,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      index: { value: 75, methodId: "cn-hj633-daily-aqi", dominantPollutants: ["so2"] },
    });
  });
});
