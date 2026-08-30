import { describe, expect, it } from "vitest";
import fixtures from "../__fixtures__/uk-daqi.json";
import { calculateDaqiLevel, ukDaqiCurrentAdapter } from "../standards/uk-daqi-current";

describe("UK DAQI 2026", () => {
  it("validates an official station-published DAQI without recomputing pollutant windows", () => {
    const result = ukDaqiCurrentAdapter.validatePublished?.(
      {
        indexId: "idx",
        methodId: "uk-daqi",
        methodRevision: "uk-air-rss-current-site-levels-v1",
        claimedStandardId: "uk-daqi-current",
        value: 4,
        displayValue: "4",
        categoryId: "moderate-4",
        dominantPollutants: [],
      },
      {
        spatial: {
          kind: "station",
          id: "UKA-AURN-BLOO",
          name: "London Bloomsbury",
          coordinates: [-0.125889, 51.522289],
          timeZone: null,
          distanceMeters: 1_000,
          stationClass: "regulatory",
          mobile: false,
          coversRequestedPoint: true,
          coverageMethod: "nearest-station",
        },
        observedAt: "2026-08-30T10:00:00.000Z",
        forecastFor: null,
        publishedAt: "2026-08-30T10:35:08.000Z",
        validUntil: "2026-08-30T12:00:00.000Z",
        subdivisionCode: "GB-ENG",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      index: {
        standardId: "uk-daqi-current",
        standardRevision: "uk-daqi-2026-04-13",
        methodId: "uk-daqi",
        value: 4,
        categoryId: "moderate-4",
        authority: "official-agency",
        derivation: "published-index",
        basis: "ground",
      },
    });
  });

  it("rejects a station-published DAQI whose category or validity contract is inconsistent", () => {
    const base = {
      indexId: "idx",
      methodId: "uk-daqi",
      methodRevision: "uk-air-rss-current-site-levels-v1",
      claimedStandardId: "uk-daqi-current" as const,
      value: 4,
      displayValue: "4",
      categoryId: "low-1",
      dominantPollutants: [],
    };
    const context = {
      spatial: {
        kind: "station" as const,
        id: "UKA-AURN-BLOO",
        name: "London Bloomsbury",
        coordinates: [-0.125889, 51.522289] as [number, number],
        timeZone: null,
        distanceMeters: 1_000,
        stationClass: "regulatory" as const,
        mobile: false,
        coversRequestedPoint: true,
        coverageMethod: "nearest-station" as const,
      },
      observedAt: "2026-08-30T10:00:00.000Z",
      forecastFor: null,
      publishedAt: "2026-08-30T10:35:08.000Z",
      validUntil: "2026-08-30T09:00:00.000Z",
      subdivisionCode: "GB-ENG",
    };

    expect(ukDaqiCurrentAdapter.validatePublished?.(base, context)).toMatchObject({
      ok: false,
    });
  });

  it("matches every independently transcribed anchor", () => {
    for (const [pollutant, cases] of Object.entries(fixtures.anchors)) {
      for (const [value, expected] of cases)
        expect(calculateDaqiLevel(pollutant as "pm25", value)).toBe(expected);
    }
  });

  it("rounds once after averaging", () => {
    expect(calculateDaqiLevel("pm10", 50.486)).toBe(3);
    expect(calculateDaqiLevel("pm10", 50.5)).toBe(4);
  });

  it.each([
    ["pm25", 60, 18],
    ["pm10", 60, 18],
    ["o3", 60, 6],
    ["no2", 15, 3],
    ["so2", 15, 1],
  ] as const)(
    "requires the exact %s window at 75%% capture",
    (pollutant, cadenceMinutes, validCount) => {
      const end = Date.parse("2026-08-30T12:00:00Z");
      const samples = Array.from({ length: validCount }, (_, offset) => ({
        startAt: new Date(end - (offset + 1) * cadenceMinutes * 60_000).toISOString(),
        endAt: new Date(end - offset * cadenceMinutes * 60_000).toISOString(),
        value: pollutant === "so2" ? 1_100 : 10,
        unit: "ug/m3" as const,
        valid: true,
        estimated: false,
        gapFilled: false,
      }));
      const base = {
        observationId: "obs",
        outputIndexId: "idx",
        evaluatedAt: "2026-08-30T12:00:00Z",
        mode: "current" as const,
        stationType: "background" as const,
      };
      const series = {
        seriesId: pollutant,
        coherenceKey: "one",
        pollutant,
        sensorId: null,
        spatialSupportId: "station",
        cadenceMinutes,
        originalUnit: "ug/m3",
        samples,
      };
      expect(ukDaqiCurrentAdapter.calculate?.({ ...base, series: [series] })).toMatchObject({
        ok: true,
      });
      expect(
        ukDaqiCurrentAdapter.calculate?.({
          ...base,
          series: [{ ...series, samples: samples.slice(1) }],
        }),
      ).toMatchObject({ ok: false, reason: "incomplete_window" });
    },
  );

  it("uses the maximum level and retains tied dominant pollutants", () => {
    const end = Date.parse("2026-08-30T12:00:00Z");
    const make = (pollutant: "no2" | "so2", value: number, cadenceMinutes: number) => ({
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant,
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes,
      originalUnit: "ug/m3",
      samples: Array.from({ length: pollutant === "no2" ? 4 : 1 }, (_, offset) => ({
        startAt: new Date(end - (offset + 1) * cadenceMinutes * 60_000).toISOString(),
        endAt: new Date(end - offset * cadenceMinutes * 60_000).toISOString(),
        value,
        unit: "ug/m3" as const,
        valid: true,
        estimated: false,
        gapFilled: false,
      })),
    });
    const result = ukDaqiCurrentAdapter.calculate?.({
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current",
      series: [make("no2", 450, 15), make("so2", 600, 15)],
    });
    expect(result).toMatchObject({
      ok: true,
      index: { value: 7, dominantPollutants: ["no2", "so2"] },
    });
  });

  it("rejects a window whose expected cadence is unknown", () => {
    const result = ukDaqiCurrentAdapter.calculate?.({
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current",
      series: [
        {
          seriesId: "no2",
          coherenceKey: "one",
          pollutant: "no2",
          sensorId: null,
          spatialSupportId: "station",
          cadenceMinutes: null,
          originalUnit: "ug/m3",
          samples: [
            {
              startAt: "2026-08-30T11:00:00Z",
              endAt: "2026-08-30T12:00:00Z",
              value: 10,
              unit: "ug/m3",
              valid: true,
              estimated: false,
              gapFilled: false,
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, reason: "incomplete_window" });
  });

  it("does not count duplicate intervals toward the 75% capture threshold", () => {
    const duplicate = {
      startAt: "2026-08-30T11:45:00Z",
      endAt: "2026-08-30T12:00:00Z",
      value: 10,
      unit: "ug/m3" as const,
      valid: true,
      estimated: false,
      gapFilled: false,
    };
    const result = ukDaqiCurrentAdapter.calculate?.({
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current",
      series: [
        {
          seriesId: "no2",
          coherenceKey: "one",
          pollutant: "no2",
          sensorId: null,
          spatialSupportId: "station",
          cadenceMinutes: 15,
          originalUnit: "ug/m3",
          samples: [duplicate, duplicate, duplicate],
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, reason: "incomplete_window" });
  });
});
