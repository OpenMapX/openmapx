import { describe, expect, it } from "vitest";
import fixtures from "../__fixtures__/us-epa-2024.json";
import {
  calculateEpaSubIndex,
  calculatePmNowCast,
  EPA_BREAKPOINTS,
  usEpa2024Adapter,
} from "../standards/us-epa-2024";

describe("US EPA 2024 AQI", () => {
  const series = (
    pollutant: "pm25" | "o3" | "so2",
    valuesNewestFirst: readonly number[],
    unit: "ug/m3" | "ppm" | "ppb",
    endAt = "2026-08-30T12:00:00Z",
  ) => {
    const end = Date.parse(endAt);
    return {
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant,
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes: 60,
      originalUnit: unit,
      samples: valuesNewestFirst.map((value, offset) => ({
        startAt: new Date(end - (offset + 1) * 3_600_000).toISOString(),
        endAt: new Date(end - offset * 3_600_000).toISOString(),
        value,
        unit,
        valid: true,
        estimated: false,
        gapFilled: false,
      })),
    };
  };

  it("matches independently recorded EPA worked examples", () => {
    for (const fixture of fixtures.examples) {
      expect(
        calculateEpaSubIndex(
          fixture.pollutant as "o3" | "pm25" | "co",
          fixture.concentration,
          fixture.windowMinutes as 60 | 480 | 1440,
        ),
      ).toBe(fixture.expectedAqi);
    }
    expect(fixtures.knownPublicationDiscrepancies).toHaveLength(1);
    expect(fixtures.examples.at(-1)).toMatchObject({ expectedAqi: 147, publishedReportedAqi: 148 });
  });

  it("uses the 2024 PM2.5 breakpoints", () => {
    expect(
      EPA_BREAKPOINTS["pm25-24h"].map(({ concentrationLow, concentrationHigh }) => [
        concentrationLow,
        concentrationHigh,
      ]),
    ).toEqual([
      [0, 9],
      [9.1, 35.4],
      [35.5, 55.4],
      [55.5, 125.4],
      [125.5, 225.4],
      [225.5, 325.4],
    ]);
  });

  it("honors every exact boundary and truncates immediately adjacent inputs", () => {
    for (const [key, bands] of Object.entries(EPA_BREAKPOINTS)) {
      const [pollutant, duration] = key.split("-");
      const window = duration === "1h" ? 60 : duration === "8h" ? 480 : 1440;
      for (const band of bands) {
        expect(calculateEpaSubIndex(pollutant as "o3", band.concentrationLow, window)).toBe(
          band.indexLow,
        );
        expect(calculateEpaSubIndex(pollutant as "o3", band.concentrationHigh, window)).toBe(
          band.indexHigh,
        );
      }
    }
    expect(calculateEpaSubIndex("pm25", 9.099, 1440)).toBe(50);
    expect(calculateEpaSubIndex("pm25", 9.1, 1440)).toBe(51);
    expect(calculateEpaSubIndex("o3", 0.070999, 480)).toBe(100);
    expect(calculateEpaSubIndex("pm25", 1_000, 1440)).toBe(500);
    expect(calculateEpaSubIndex("o3", 1, 60)).toBe(500);
    expect(calculateEpaSubIndex("o3", 1, 480)).toBeNull();
    expect(calculateEpaSubIndex("so2", 2_000, 60)).toBeNull();
    expect(calculateEpaSubIndex("so2", 2_000, 1440)).toBe(500);
    expect(calculateEpaSubIndex("pm25", Number.NaN, 1440)).toBeNull();
    expect(calculateEpaSubIndex("pm25", -1, 1440)).toBeNull();
  });

  it("requires two valid values in the latest three hours for PM NowCast", () => {
    expect(calculatePmNowCast([12, null, null, 12])).toBeNull();
    expect(calculatePmNowCast([12, null, 12])).toBe(12);
    expect(calculatePmNowCast(Array(12).fill(10))).toBe(10);
  });

  it("keeps current and daily methods distinct and rejects a latest reading", () => {
    const result = usEpa2024Adapter.calculate?.({
      observationId: "obs_1_fixture",
      outputIndexId: "idx_1_fixture",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current",
      series: [
        {
          seriesId: "pm25",
          coherenceKey: "one",
          pollutant: "pm25",
          sensorId: null,
          spatialSupportId: "station",
          cadenceMinutes: 60,
          originalUnit: "ug/m3",
          samples: [
            {
              startAt: "2026-08-30T11:00:00Z",
              endAt: "2026-08-30T12:00:00Z",
              value: 12,
              unit: "ug/m3",
              valid: true,
              estimated: false,
              gapFilled: false,
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      reason: "incomplete_window",
      missingRequirements: ["No complete EPA pollutant window"],
    });
  });

  it("reports the larger of the one-hour and eight-hour ozone AQIs", () => {
    const result = usEpa2024Adapter.calculate?.({
      observationId: "obs_o3",
      outputIndexId: "idx_o3",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current",
      series: [series("o3", [0.2, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05], "ppm")],
    });

    expect(result).toMatchObject({
      ok: true,
      index: { value: 195, dominantPollutants: ["o3"] },
    });
  });

  it("uses the 24-hour SO2 table when the one-hour table does not define the AQI", () => {
    const result = usEpa2024Adapter.calculate?.({
      observationId: "obs_so2",
      outputIndexId: "idx_so2",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current",
      series: [series("so2", Array(24).fill(400), "ppb")],
    });

    expect(result).toMatchObject({
      ok: true,
      index: { value: 232, dominantPollutants: ["so2"] },
    });
  });

  it("does not construct a current PM NowCast from stale hourly samples", () => {
    const result = usEpa2024Adapter.calculate?.({
      observationId: "obs_stale",
      outputIndexId: "idx_stale",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current",
      series: [series("pm25", Array(12).fill(12), "ug/m3", "2026-08-29T12:00:00Z")],
    });

    expect(result).toMatchObject({ ok: false, reason: "incomplete_window" });
  });

  it("uses the daily maximum rolling eight-hour concentration outside current mode", () => {
    const values = Array(31).fill(1) as number[];
    values.fill(10, 16, 24);
    const input = {
      observationId: "obs_daily",
      outputIndexId: "idx_daily",
      evaluatedAt: "2026-08-30T12:00:00Z",
      series: [
        {
          ...series("o3", [], "ppm"),
          seriesId: "co",
          pollutant: "co" as const,
          samples: series("o3", values, "ppm").samples,
        },
      ],
    };

    expect(usEpa2024Adapter.calculate?.({ ...input, mode: "current" })).toMatchObject({
      ok: true,
      index: { value: 11, methodId: "epa-nowcast-aqi" },
    });
    expect(usEpa2024Adapter.calculate?.({ ...input, mode: "history" })).toMatchObject({
      ok: true,
      index: { value: 109, methodId: "epa-daily-aqi" },
    });
  });
});
