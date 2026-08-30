import { describe, expect, it } from "vitest";
import fixture from "../__fixtures__/in-naqi.json";
import { calculateNaqiSubIndex, inNaqiCurrentAdapter } from "../standards/in-naqi-current";

describe("India CPCB NAQI", () => {
  it("matches every independent breakpoint fixture", () => {
    for (const [pollutant, concentration, expected] of fixture.boundaryCases) {
      expect(calculateNaqiSubIndex(pollutant as "pm25", concentration as number)).toBe(expected);
    }
    for (const [pollutant, concentration] of fixture.unsettledSevereCases) {
      expect(calculateNaqiSubIndex(pollutant as "pm25", concentration as number)).toBeNull();
    }
  });

  it("rejects fewer than three pollutants or three without particulate matter", () => {
    const end = Date.parse("2026-08-30T24:00:00Z");
    const make = (pollutant: "pm25" | "no2" | "so2" | "nh3", value: number) => ({
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant,
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes: 60,
      originalUnit: "ug/m3",
      samples: Array.from({ length: 24 }, (_, offset) => ({
        startAt: new Date(end - (offset + 1) * 3_600_000).toISOString(),
        endAt: new Date(end - offset * 3_600_000).toISOString(),
        value,
        unit: "ug/m3" as const,
        valid: true,
        estimated: false,
        gapFilled: false,
      })),
    });
    const input = {
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: new Date(end).toISOString(),
      mode: "current" as const,
    };
    expect(
      inNaqiCurrentAdapter.calculate?.({ ...input, series: [make("pm25", 31), make("no2", 41)] }),
    ).toMatchObject({ ok: false, reason: "missing_required_pollutant" });
    expect(
      inNaqiCurrentAdapter.calculate?.({
        ...input,
        series: [make("no2", 41), make("so2", 41), make("nh3", 201)],
      }),
    ).toMatchObject({ ok: false, reason: "missing_required_pollutant" });
    expect(
      inNaqiCurrentAdapter.calculate?.({
        ...input,
        series: [make("pm25", 31), make("no2", 41), make("so2", 41)],
      }),
    ).toMatchObject({ ok: true, index: { value: 51, dominantPollutants: ["no2", "pm25", "so2"] } });
  });

  it("requires at least sixteen valid hourly samples for every sub-index", () => {
    const input = {
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: "2026-08-30T16:00:00Z",
      mode: "current" as const,
    };
    const series = ["pm25", "no2", "so2"].map((pollutant) => ({
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant: pollutant as "pm25",
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes: 60,
      originalUnit: "ug/m3",
      samples: Array.from({ length: 15 }, (_, hour) => ({
        startAt: `2026-08-30T${String(hour).padStart(2, "0")}:00:00Z`,
        endAt: `2026-08-30T${String(hour + 1).padStart(2, "0")}:00:00Z`,
        value: 10,
        unit: "ug/m3" as const,
        valid: true,
        estimated: false,
        gapFilled: false,
      })),
    }));
    expect(inNaqiCurrentAdapter.calculate?.({ ...input, series })).toMatchObject({ ok: false });
  });

  it("does not build an eight-hour CO or ozone value from sparse recent evidence", () => {
    const evaluatedAt = "2026-08-31T00:00:00Z";
    const make = (pollutant: "pm25" | "co" | "o3", unit: "ug/m3" | "mg/m3") => ({
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant,
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes: 60,
      originalUnit: unit,
      samples: [
        ...Array.from({ length: 15 }, (_, hour) => ({
          startAt: `2026-08-30T${String(hour).padStart(2, "0")}:00:00Z`,
          endAt: `2026-08-30T${String(hour + 1).padStart(2, "0")}:00:00Z`,
          value: 10,
          unit,
          valid: true,
          estimated: false,
          gapFilled: false,
        })),
        {
          startAt: "2026-08-30T23:00:00Z",
          endAt: evaluatedAt,
          value: 10,
          unit,
          valid: true,
          estimated: false,
          gapFilled: false,
        },
      ],
    });

    expect(
      inNaqiCurrentAdapter.calculate?.({
        observationId: "obs",
        outputIndexId: "idx",
        evaluatedAt,
        mode: "current",
        series: [make("pm25", "ug/m3"), make("co", "mg/m3"), make("o3", "ug/m3")],
      }),
    ).toMatchObject({ ok: false, reason: "missing_required_pollutant" });
  });

  it("rejects the open-ended Severe numeric path instead of inventing upper breakpoints", () => {
    const end = Date.parse("2026-08-31T00:00:00Z");
    const make = (pollutant: "pm25" | "no2" | "so2", value: number) => ({
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant,
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes: 60,
      originalUnit: "ug/m3",
      samples: Array.from({ length: 24 }, (_, offset) => ({
        startAt: new Date(end - (offset + 1) * 3_600_000).toISOString(),
        endAt: new Date(end - offset * 3_600_000).toISOString(),
        value,
        unit: "ug/m3" as const,
        valid: true,
        estimated: false,
        gapFilled: false,
      })),
    });

    expect(
      inNaqiCurrentAdapter.calculate?.({
        observationId: "obs",
        outputIndexId: "idx",
        evaluatedAt: new Date(end).toISOString(),
        mode: "current",
        series: [make("pm25", 251), make("no2", 80), make("so2", 80)],
      }),
    ).toMatchObject({ ok: false, reason: "unverified_method" });
    expect(calculateNaqiSubIndex("pm25", 30.5)).toBeNull();
  });
});
